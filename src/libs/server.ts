import {
  BINARY_BODY,
  CORSHeaders,
  Environment,
  GetContentType,
  GetRouteResponseContentType,
  Header,
  IsValidURL,
  MimeTypesWithTemplating,
  MockoonServerOptions,
  Route,
  ServerErrorCodes,
  ServerEvents,
  TestHeaderValidity
} from '@mockoon/commons';
import cookieParser from 'cookie-parser';
import { EventEmitter } from 'events';
import express, { Application, NextFunction, Request, Response } from 'express';
import { readFile } from 'fs';
import {
  ClientRequest,
  createServer as httpCreateServer,
  IncomingMessage,
  Server as httpServer
} from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import {
  createServer as httpsCreateServer,
  Server as httpsServer
} from 'https';
import killable from 'killable';
import { lookup as mimeTypeLookup } from 'mime-types';
import { basename } from 'path';
import { parse as qsParse } from 'qs';
import TypedEmitter from 'typed-emitter';
import { DefaultSSLConfig } from '../constants/ssl.constants';
import { Texts } from '../i18n/en';
import { ResponseRulesInterpreter } from './response-rules-interpreter';
import { TemplateParser } from './template-parser';
import { CreateTransaction } from './utils';

/**
 * Create a server instance from an Environment object.
 *
 * Extends EventEmitter.
 */
export class MockoonServer extends (EventEmitter as new () => TypedEmitter<ServerEvents>) {
  private serverInstance: httpServer | httpsServer;

  constructor(
    private environment: Environment,
    private options: MockoonServerOptions = {}
  ) {
    super();
  }
  /**
   * Start a server
   */
  public start() {
    const server = express();
    server.disable('x-powered-by');
    server.disable('etag');

    // create https or http server instance
    if (this.environment.https) {
      this.serverInstance = httpsCreateServer(DefaultSSLConfig, server);
    } else {
      this.serverInstance = httpCreateServer(server);
    }

    // make serverInstance killable
    this.serverInstance = killable(this.serverInstance);

    // set timeout long enough to allow long latencies
    this.serverInstance.setTimeout(3_600_000);

    // handle server errors
    this.serverInstance.on('error', (error) => {
      let errorCode = ServerErrorCodes.UNKNOWN_SERVER_ERROR;

      if (error.code === 'EADDRINUSE') {
        errorCode = ServerErrorCodes.PORT_ALREADY_USED;
      } else if (error.code === 'EACCES') {
        errorCode = ServerErrorCodes.PORT_INVALID;
      }

      this.emit('error', errorCode, error);
    });

    this.serverInstance.listen(this.environment.port, () => {
      this.emit('started');
    });

    server.use(this.emitEvent);
    server.use(this.delayResponse);
    server.use(this.deduplicateSlashes);
    server.use(cookieParser());
    server.use(this.parseBody);
    server.use(this.logRequest);
    server.use(this.setResponseHeaders);

    this.setRoutes(server);
    this.setCors(server);
    this.enableProxy(server);
    server.use(this.errorHandler);
  }

  /**
   * Kill the server
   */
  public stop() {
    if (this.serverInstance) {
      this.serverInstance.kill(() => {
        this.emit('stopped');
      });
    }
  }

  /**
   * ### Middleware ###
   * Emit the SERVER_ENTERING_REQUEST event
   *
   * @param request
   * @param response
   * @param next
   */
  private emitEvent = (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    this.emit('entering-request');
    next();
  };

  /**
   * ### Middleware ###
   * Add global latency to the mock server
   *
   * @param request
   * @param response
   * @param next
   */
  private delayResponse = (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    this.refreshEnvironment();

    setTimeout(next, this.environment.latency);
  };

  /**
   * ### Middleware ###
   * Remove duplicate slashes in entering call paths
   *
   * @param request
   * @param response
   * @param next
   */
  private deduplicateSlashes(
    request: Request,
    response: Response,
    next: NextFunction
  ) {
    request.url = request.url.replace(/\/{2,}/g, '/');

    next();
  }

  /**
   * ### Middleware ###
   * Parse entering request body
   *
   * @param request
   * @param response
   * @param next
   */
  private parseBody = (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    // Parse body as a raw string and JSON/form if applicable
    const requestContentType: string | undefined =
      request.header('Content-Type');

    const rawBody: Buffer[] = [];

    request.on('data', (chunk) => {
      rawBody.push(Buffer.from(chunk, 'binary'));
    });

    request.on('end', () => {
      request.rawBody = Buffer.concat(rawBody);
      request.body = request.rawBody.toString('utf8');

      try {
        if (requestContentType) {
          if (requestContentType.includes('application/json')) {
            request.bodyJSON = JSON.parse(request.body);
          } else if (
            requestContentType.includes('application/x-www-form-urlencoded')
          ) {
            request.bodyForm = qsParse(request.body, {
              depth: 10
            });
          }
        }
      } catch (error) {
        this.emit('error', ServerErrorCodes.REQUEST_BODY_PARSE, error);
      }

      next();
    });
  };

  /**
   * ### Middleware ###
   * Emit an event when response emit the 'close' event
   *
   * @param request
   * @param response
   * @param next
   */
  private logRequest = (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    response.on('close', () => {
      this.emit('transaction-complete', CreateTransaction(request, response));
    });

    next();
  };

  /**
   * ### Middleware ###
   * Add environment headers & proxy headers to the response
   *
   * @param request
   * @param response
   * @param next
   */
  private setResponseHeaders = (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    this.setHeaders(this.environment.headers, response, request);

    next();
  };

  /**
   * Generate an environment routes and attach to running server
   *
   * @param server - server on which attach routes
   */
  private setRoutes(server: Application) {
    this.environment.routes.forEach((declaredRoute: Route) => {
      // only launch non duplicated routes, or ignore if none.
      if (declaredRoute.enabled) {
        try {
          let routePath = `/${
            this.environment.endpointPrefix
          }/${declaredRoute.endpoint.replace(/ /g, '%20')}`;

          routePath = routePath.replace(/\/{2,}/g, '/');

          let requestNumber = 1;

          // create route
          server[declaredRoute.method](
            routePath,
            (request: Request, response: Response) => {
              // refresh environment data to get route changes that do not require a restart (headers, body, etc)
              this.refreshEnvironment();
              const currentRoute = this.getRefreshedRoute(declaredRoute);

              if (!currentRoute) {
                this.sendError(
                  response,
                  Texts.EN.MESSAGES.ROUTE_NO_LONGER_EXISTS,
                  404
                );

                return;
              }

              const enabledRouteResponse = new ResponseRulesInterpreter(
                currentRoute.responses,
                request,
                currentRoute.randomResponse,
                currentRoute.sequentialResponse
              ).chooseResponse(requestNumber);

              requestNumber += 1;

              // save route and response UUIDs for logs (only in desktop app)
              if (declaredRoute.uuid && enabledRouteResponse.uuid) {
                response.routeUUID = declaredRoute.uuid;
                response.routeResponseUUID = enabledRouteResponse.uuid;
              }

              // add route latency if any
              setTimeout(() => {
                const contentType = GetRouteResponseContentType(
                  this.environment,
                  enabledRouteResponse
                );
                const routeContentType = GetContentType(
                  enabledRouteResponse.headers
                );

                // set http code
                response.status(enabledRouteResponse.statusCode);

                this.setHeaders(
                  enabledRouteResponse.headers,
                  response,
                  request
                );

                try {
                  // send the file
                  if (enabledRouteResponse.filePath) {
                    const filePath = TemplateParser(
                      enabledRouteResponse.filePath.replace(/\\/g, '/'),
                      request,
                      this.environment
                    );
                    const fileMimeType = mimeTypeLookup(filePath) || '';

                    // set content-type to route response's one or the detected mime type if none
                    if (!routeContentType) {
                      response.set('Content-Type', fileMimeType);
                    }

                    if (!enabledRouteResponse.sendFileAsBody) {
                      response.set(
                        'Content-Disposition',
                        `attachment; filename="${basename(filePath)}"`
                      );
                    }

                    readFile(filePath, (readError, data) => {
                      try {
                        if (readError) {
                          throw readError;
                        }

                        // parse templating for a limited list of mime types
                        if (
                          MimeTypesWithTemplating.indexOf(fileMimeType) > -1 &&
                          !enabledRouteResponse.disableTemplating
                        ) {
                          const fileContent = TemplateParser(
                            data.toString(),
                            request,
                            this.environment
                          );
                          response.body = fileContent;
                          response.send(fileContent);
                        } else {
                          response.body = BINARY_BODY;
                          response.send(data);
                        }
                      } catch (error) {
                        this.emit(
                          'error',
                          ServerErrorCodes.ROUTE_FILE_SERVING_ERROR,
                          error
                        );

                        this.sendError(
                          response,
                          `${Texts.EN.MESSAGES.ROUTE_FILE_SERVING_ERROR}${error.message}`
                        );
                      }
                    });
                  } else {
                    if (contentType.includes('application/json')) {
                      response.set('Content-Type', 'application/json');
                    }

                    let body = enabledRouteResponse.body;

                    if (!enabledRouteResponse.disableTemplating) {
                      body = TemplateParser(
                        body || '',
                        request,
                        this.environment
                      );
                    }

                    response.body = body;

                    response.send(body);
                  }
                } catch (error) {
                  this.emit(
                    'error',
                    ServerErrorCodes.ROUTE_SERVING_ERROR,
                    error
                  );

                  this.sendError(
                    response,
                    `${Texts.EN.MESSAGES.ROUTE_SERVING_ERROR}${error.message}`
                  );
                }
              }, enabledRouteResponse.latency);
            }
          );
        } catch (error) {
          let errorCode = ServerErrorCodes.ROUTE_CREATION_ERROR;

          // if invalid regex defined
          if (error.message.indexOf('Invalid regular expression') > -1) {
            errorCode = ServerErrorCodes.ROUTE_CREATION_ERROR_REGEX;
          }

          this.emit('error', errorCode, error);
        }
      }
    });
  }

  /**
   * Always answer with status 200 to CORS pre flight OPTIONS requests if option activated.
   * /!\ Must be called after the routes creation otherwise it will intercept all user defined OPTIONS routes.
   *
   * @param server - express instance
   */
  private setCors(server: Application) {
    if (this.environment.cors) {
      server.options('/*', (req, res) => {
        this.refreshEnvironment();

        // override default CORS headers with environment's headers
        this.setHeaders(
          [...CORSHeaders, ...this.environment.headers],
          res,
          req
        );

        res.status(200).end();
      });
    }
  }

  /**
   * Add catch-all proxy if enabled.
   * Restream the body to the proxied API because it already has been
   * intercepted by the body parser.
   *
   * @param server - server on which to launch the proxy
   */
  private enableProxy(server: Application) {
    if (
      this.environment.proxyMode &&
      this.environment.proxyHost &&
      IsValidURL(this.environment.proxyHost)
    ) {
      this.emit('creating-proxy');

      server.use(
        '*',
        createProxyMiddleware({
          target: this.environment.proxyHost,
          secure: false,
          changeOrigin: true,
          logProvider: this.options.logProvider,
          ssl: { ...DefaultSSLConfig, agent: false },
          onProxyReq: (
            proxyReq: ClientRequest,
            request: Request,
            response: Response
          ) => {
            this.refreshEnvironment();

            request.proxied = true;

            this.setHeaders(
              this.environment.proxyReqHeaders,
              proxyReq,
              request
            );

            if (
              this.environment.proxyRemovePrefix === true &&
              this.environment.endpointPrefix.length > 0
            ) {
              const regExp = new RegExp(`^/${this.environment.endpointPrefix}`);
              proxyReq.path = proxyReq.path.replace(regExp, '');
            }

            // re-stream the body (intercepted by body parser method)
            if (request.rawBody) {
              proxyReq.write(request.rawBody);
            }
          },
          onProxyRes: (
            proxyRes: IncomingMessage,
            request: Request,
            response: Response
          ) => {
            this.refreshEnvironment();

            let body = '';
            proxyRes.on('data', (chunk) => {
              body += chunk;
            });
            proxyRes.on('end', () => {
              response.body = body;
            });

            this.setHeaders(
              this.environment.proxyResHeaders,
              proxyRes,
              request
            );
          },
          onError: (error: Error, request: Request, response: Response) => {
            this.emit('error', ServerErrorCodes.PROXY_ERROR, error);
            this.sendError(
              response,
              `${Texts.EN.MESSAGES.PROXY_ERROR}${this.environment.proxyHost}${request.url}: ${error}`,
              504
            );
          }
        })
      );
    }
  }

  /**
   * ### Middleware ###
   * Catch all error handler
   * http://expressjs.com/en/guide/error-handling.html#catching-errors
   *
   * @param server - server on which to log the response
   */
  private errorHandler = (
    error: any,
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    this.sendError(response, error, 500);
  };

  /**
   * Set the provided headers on the target. Use different headers accessors
   * depending on the type of target:
   * express.Response/http.OutgoingMessage/http.IncomingMessage
   * Use the source in the template parsing of each header value.
   *
   * @param headers
   * @param target
   * @param request
   */
  private setHeaders(headers: Header[], target: any, request: Request) {
    headers.forEach((header: Header) => {
      const parsedHeaderValue = this.parseHeader(header, request);

      if (parsedHeaderValue === null) {
        return;
      }

      if (target.set) {
        // for express.Response
        if (header.key.toLowerCase() === 'content-type') {
          target.set(header.key, parsedHeaderValue);
        } else {
          target.append(header.key, parsedHeaderValue);
        }
      } else if (target.setHeader) {
        // for proxy http.OutgoingMessage
        target.setHeader(
          header.key,
          this.appendHeaderValue(
            target.getHeader(header.key),
            parsedHeaderValue
          )
        );
      } else {
        // for http.IncomingMessage
        target.headers[header.key] = this.appendHeaderValue(
          target.headers[header.key],
          parsedHeaderValue
        );
      }
    });
  }

  /**
   * If header already has a value, concatenate the values into an array
   *
   * @param currentValue
   * @param newValue
   * @returns
   */
  private appendHeaderValue(
    currentValue: string | string[],
    newValue: string
  ): string | string[] {
    let headerValue: string | string[] = newValue;

    if (currentValue) {
      headerValue = Array.isArray(currentValue)
        ? currentValue.concat(headerValue)
        : [currentValue, headerValue];
    }

    return headerValue;
  }

  /**
   * Verify a header validity and parse its content, if templating is used
   *
   * @param header
   * @param request
   * @returns
   */
  private parseHeader(header: Header, request: Request): string | null {
    let parsedHeaderValue: string | null = null;

    if (header.key && header.value && !TestHeaderValidity(header.key)) {
      try {
        parsedHeaderValue = TemplateParser(
          header.value,
          request,
          this.environment
        );
      } catch (error) {
        const errorMessage = Texts.EN.MESSAGES.HEADER_PARSING_ERROR;
        parsedHeaderValue = errorMessage;
      }
    }

    return parsedHeaderValue;
  }

  /**
   * Send an error with text/plain content type, the provided message and status code.
   * Status is optional. No status will default to the one defined by the user, allowing for maximum customization.
   *
   * @param response
   * @param errorMessage
   * @param status
   */
  private sendError(response: Response, errorMessage: string, status?: number) {
    response.set('Content-Type', 'text/plain');
    response.body = errorMessage;

    if (status !== undefined) {
      response.status(status);
    }

    response.send(errorMessage);
  }

  /**
   * Request an updated environment to allow
   * modification of some parameters without a restart (latency, headers, etc)
   */
  private refreshEnvironment() {
    if (this.options.refreshEnvironmentFunction && this.environment.uuid) {
      const updatedEnvironment = this.options.refreshEnvironmentFunction(
        this.environment.uuid
      );

      if (updatedEnvironment) {
        this.environment = updatedEnvironment;
      }
    }
  }

  /**
   * Request an updated route to allow
   * modification of some parameters without a restart (latency, headers, etc)
   * This only makes sense if the refreshEnvironmentFunction has been provided.
   *
   * @param routeUUID
   */
  private getRefreshedRoute(currentRoute: Route): Route | undefined {
    if (this.options.refreshEnvironmentFunction && this.environment.uuid) {
      return this.environment.routes.find(
        (route) => route.uuid === currentRoute.uuid
      );
    }

    return currentRoute;
  }
}
