/*global URL, XMLHttpRequest*/
define(['util', 'HttpError', 'api/index'], function (util, HttpError, Api) {
    'use strict';

    /**
     * @exports Client
     * @constructor
     * @param {Object} [config]
     * @param {Boolean} config.debug
     */
    var Client = function (config) {
        config = config || {};
        this.config = config;
        this.debug = config.debug;

        this.api = new Api(this);

        this.setupRoutes();
    };

    /**
     *  Configures the routes as defined in a routes.json file of an API version
     *
     *  Client.setupRoutes is invoked by the constructor, takes the
     *  contents of the JSON document that contains the definitions of all the
     *  available API routes and iterates over them.
     *
     *  It first recurses through each definition block until it reaches an API
     *  endpoint. It knows that an endpoint is found when the `url` and `param`
     *  definitions are found as a direct member of a definition block.
     *  Then the availability of an implementation by the API is checked; if it's
     *  not present, this means that a portion of the API as defined in the routes.json
     *  file is not implemented properly, thus an exception is thrown.
     *  After this check, a method is attached to the [[Client]] instance
     *  and becomes available for use. Inside this method, the parameter validation
     *  and typecasting is done, according to the definition of the parameters in
     *  the `params` block, upon invocation.
     *
     *  This mechanism ensures that the handlers ALWAYS receive normalized data
     *  that is of the correct format and type. JSON parameters are parsed, Strings
     *  are trimmed, Numbers and Floats are casted and checked for NaN after that.
     *
     *  Note: Query escaping for usage with SQL products is something that can be
     *  implemented additionally by adding an additional parameter type.
     **/
    Client.prototype.setupRoutes = function () {
        var self = this;
        var api = this.api;
        var routes = api.routes;
        var defines = routes.defines;
        this.constants = defines.constants;
        this.requestHeaders = defines['request-headers'].map(function (header) {
            return header.toLowerCase();
        });
        delete routes.defines;

        function trim(s) {
            if (typeof s === 'string') {
                s = s.replace(/^[\s\t\r\n]+/, '').replace(/[\s\t\r\n]+$/, '');
            }
            return s;
        }

        function parseParams(msg, paramsStruct) {
            var params = Object.keys(paramsStruct);
            var paramName, def, value, type;
            for (var i = 0, l = params.length; i < l; i = i + 1) {
                paramName = params[i];
                if (paramName.charAt(0) === '$') {
                    paramName = paramName.substr(1);
                    if (!defines.params[paramName]) {
                        util.error('Invalid variable parameter name substitution; param "' +
                            paramName + '" not found in defines block');
                    } else {
                        def = defines.params[paramName];
                    }
                } else {
                    def = paramsStruct[paramName];
                }

                value = trim(msg[paramName]);
                if (typeof value !== 'boolean' && !value) {
                    // we don't need to validation for undefined parameter values
                    // that are not required.
                    if (def.required) {
                        util.error('Empty value for parameter "' + paramName + '": ' + value);
                    } else {
                        continue;
                    }
                }

                // validate the value and type of parameter:
                if (def.validation) {
                    if (!new RegExp(def.validation).test(value)) {
                        util.error('Invalid value for parameter "' + paramName + '": ' + value);
                    }
                }

                if (def.type) {
                    type = def.type.toLowerCase();
                    if (type === 'number') {
                        value = parseInt(value, 10);
                        if (isNaN(value)) {
                            util.error('Invalid value for parameter "' + paramName + '": ' + msg[paramName] + ' is NaN');
                        }
                    } else if (type === 'float') {
                        value = parseFloat(value);
                        if (isNaN(value)) {
                            util.error('Invalid value for parameter "' + paramName + '": ' + msg[paramName] + ' is NaN');
                        }
                    } else if (type === 'json') {
                        if (typeof value === 'string') {
                            try {
                                value = JSON.parse(value);
                            } catch (ex) {
                                util.error('JSON parse error of value for parameter "' + paramName + '": ' + value);
                                throw ex;
                            }
                        }
                    } else if (type === 'date') {
                        value = new Date(value);
                    }
                }
                msg[paramName] = value;
            }
        }

        function prepareApi(struct, baseType) {
            baseType = baseType || '';

            Object.keys(struct).forEach(function (routePart) {
                var block = struct[routePart];
                if (!block) {
                    return;
                }
                var messageType = baseType + '/' + routePart;
                if (block.url && block.params) {
                    // we ended up at an API definition part!
                    var endPoint = messageType.replace(/^[\/]+/g, '');
                    var parts = messageType.split('/');
                    var section = util.toCamelCase(parts[1].toLowerCase());
                    parts.splice(0, 2);
                    var funcName = util.toCamelCase(parts.join('-'));

                    if (!api[section]) {
                        util.error('Unsupported route section, not implemented in version ' +
                            self.version + ' for route "' + endPoint + '" and block: ', block);
                    }

                    if (!api[section][funcName]) {
                        if (self.debug) {
                            util.log('Tried to call ' + funcName);
                        }
                        util.error('Unsupported route, not implemented in version ' +
                            self.version + ' for route "' + endPoint + '" and block: ', block);
                    }

                    if (!self[section]) {
                        self[section] = {};
                        // add a utility function 'getFooApi()', which returns the
                        // section to which functions are attached.
                        self[util.toCamelCase('get-' + section + '-api')] = function () {
                            return self[section];
                        };
                    }

                    self[section][funcName] = function (msg, callback) {
                        try {
                            parseParams(msg, block.params);
                        } catch (ex) {
                            // when the message was sent to the client, we can
                            // reply with the error directly.
                            api.sendError(ex, block, msg, callback);
                            if (self.debug) {
                                util.log(ex.message);
                            }
                            // on error, there's no need to continue.
                            return;
                        }

                        api[section][funcName].call(api, msg, block, callback);
                    };
                } else {
                    // recurse into this block next:
                    prepareApi(block, messageType);
                }
            });
        }

        prepareApi(routes);
        routes.defines = defines;
    };

    /**
     *  Set an authentication method to have access to protected resources.
     *  @example
     *  // basic
     *  github.authenticate({
         *      type: "basic",
         *      username: "mikedeboertest",
         *      password: "test1324"
         *  });
     *
     *  // or oauth
     *  github.authenticate({
         *      type: "oauth",
         *      token: "e5a4a27487c26e571892846366de023349321a73"
         *  });
     *  @param {Object} authConfig Object containing the authentication type and credentials
     *  @param {String} authConfig.type One of the following: `basic`, `oauth` or `token`
     *  @param {String} [authConfig.username] Github username
     *  @param {String} [authConfig.password] Password to your account
     *  @param {String} [authConfig.token] OAuth2 token
     **/
    Client.prototype.authenticate = function (authConfig) {
        if (!authConfig) {
            this.auth = false;
            return;
        }
        if (!authConfig.type || 'basic|oauth|token'.indexOf(authConfig.type) === -1) {
            util.error('Invalid authentication type, must be "basic", "oauth" or "token"');
        }
        if (authConfig.type === 'basic' && (!authConfig.username || !authConfig.password)) {
            util.error('Basic authentication requires both a username and password to be set');
        }
        if (authConfig.type === 'oauth' && !authConfig.token) {
            util.error('OAuth2 authentication requires a token to be set');
        }

        if (authConfig.type === 'token' && !authConfig.token) {
            util.error('OAuth2 authentication requires a token to be set');
        }

        this.auth = authConfig;
    };

    /**
     *
     * @param {Object | String} link
     * @returns {Object}
     * @config {String} next
     * @config {String} prev
     * @config {String} first
     * @config {String} last
     * @private
     */
    function _getPageLinks(link) {
        if (typeof link === 'object' && (link.link || link.meta.link)) {
            link = link.link || link.meta.link;
        }

        var links = {
            next: null,
            prev: null,
            first: null,
            last: null
        };
        if (typeof link !== 'string') {
            return links;
        }

        // link format:
        // '<https://api.github.com/users/aseemk/followers?page=2>; rel="next", <https://api.github.com/users/aseemk/followers?page=2>; rel="last"'
        link.replace(/<([^>]*)>;\s*rel="([\w]*)\"/g, function (m, uri, type) {
            links[type] = uri;
        });
        return links;
    }

    /**
     *  Check if a request result contains a link to the next page
     *  @param {Object | String} link response of a request or the contents of the Link header
     *  @returns {Boolean}
     **/
    Client.prototype.hasNextPage = function (link) {
        return _getPageLinks(link).next ? true : false;
    };

    /**
     *  Check if a request result contains a link to the previous page
     *  @param {Object | String} link response of a request or the contents of the Link header
     *  @returns {Boolean}
     **/
    Client.prototype.hasPreviousPage = function (link) {
        return _getPageLinks(link).prev ? true : false;
    };

    /**
     *  Check if a request result contains a link to the last page
     *  @param {Object | String} link response of a request or the contents of the Link header
     *  @returns {Boolean}
     **/
    Client.prototype.hasLastPage = function (link) {
        return _getPageLinks(link).last ? true : false;
    };

    /**
     *  Check if a request result contains a link to the first page
     *  @param {Object | String} link response of a request or the contents of the Link header
     *  @returns {Boolean}
     **/
    Client.prototype.hasFirstPage = function (link) {
        return _getPageLinks(link).first ? true : false;
    };

    /**
     *
     * @param {String} link
     * @param {String} which
     * @param callback
     * @param {Client} client
     * @returns {*}
     * @private
     */
    function _getPage(link, which, callback, client) {
        var url = _getPageLinks(link)[which];
        if (!url) {
            util.error('No ' + which + ' page found');
        } else {
            var api = client.api;
            client.httpSendForGetPage(new URL(url), function (err, res) {
                if (err) {
                    return api.sendError(err, null, url, callback);
                }

                var ret;
                try {
                    ret = res.data && JSON.parse(res.data);
                } catch (ex) {
                    if (callback) {
                        util.error(ex.message, res);
                    }
                    return;
                }

                if (!ret) {
                    ret = {};
                }
                if (!ret.meta) {
                    ret.meta = {};
                }
                ['x-ratelimit-limit', 'x-ratelimit-remaining', 'link'].forEach(function (header) {
                    if (res.headers[header]) {
                        ret.meta[header] = res.headers[header];
                    }
                });

                if (callback) {
                    callback(null, ret);
                }
            });
        }

    }

    /**
     *
     * @param {String} url
     * @param {Function} callback
     */
    Client.prototype.httpSendForGetPage = function (url, callback) {
        var self = this;
        var headers = [];
        headers['content-type'] = 'application/json; charset=utf-8';
        headers.authorization = 'token ' + this.auth.token;
        var callbackCalled = false;

        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        Object.keys(headers).forEach(function (header) {
            xhr.setRequestHeader(header, headers[header]);
        });
        xhr.onreadystatechange = function () {
            if (self.debug) {
                util.log('STATUS: ' + xhr.status);
            }
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) {
                    var res = {
                        headers: {},
                        data: null
                    };
                    var headersSplit = xhr.getAllResponseHeaders().split('\n');
                    for (var i = 0, length = headersSplit.length; i < length; i = i + 1) {
                        var header = headersSplit[i];
                        if (header !== '' && header.indexOf(':') !== -1) {
                            var dividerIndex = header.indexOf(':');
                            var key = header.substring(0, dividerIndex).trim().toLowerCase();
                            res.headers[key] = header.substring(dividerIndex + 1).trim();
                        }
                    }
                    res.data = xhr.responseText;
                    callbackCalled = true;
                    callback(null, res);
                } else if (!callbackCalled && xhr.status >= 400 && xhr.status < 600 || xhr.status < 10) {
                    util.error(xhr.status, xhr.responseText); //TODO use HttpError instead
                }
            }
        };
        xhr.send();
    };

    /**
     *  Get the next page, based on the contents of the `Link` header
     *  @param {Object | String} link response of a request or the contents of the Link header
     *  @param {Function} callback function to call when the request is finished with an error as first argument and result data as second argument.
     **/
    Client.prototype.getNextPage = function (link, callback) {
        _getPage(link, 'next', callback, this);
    };

    /**
     *  Get the previous page, based on the contents of the `Link` header
     *  @param {Object | String} link response of a request or the contents of the Link header
     *  @param {Function} callback function to call when the request is finished with an error as first argument and result data as second argument.
     **/
    Client.prototype.getPreviousPage = function (link, callback) {
        _getPage(link, 'prev', callback, this);
    };

    /**
     *  Get the last page, based on the contents of the `Link` header
     *  @param {Object | String} link response of a request or the contents of the Link header
     *  @param {Function} callback function to call when the request is finished with an error as first argument and result data as second argument.
     **/
    Client.prototype.getLastPage = function (link, callback) {
        _getPage(link, 'last', callback, this);
    };

    /**
     *  Get the first page, based on the contents of the `Link` header
     *  @param {Object | String} link response of a request or the contents of the Link header
     *  @param {Function} callback function to call when the request is finished with an error as first argument and result data as second argument.
     **/
    Client.prototype.getFirstPage = function (link, callback) {
        _getPage(link, 'first', callback, this);
    };

    /**
     *
     * @param msg
     * @param {Object} def
     * @config {String} url
     * @param format
     * @returns {{url: (*|block.url|string|ret.url), query: {}}}
     * @private
     */
    function _getQueryAndUrl(msg, def, format) {
        var ret = {
            url: def.url,
            query: format === 'json' ? {} : []
        };
        if (!def || !def.params) {
            return ret;
        }
        var url = def.url;
        Object.keys(def.params).forEach(function (paramName) {
            paramName = paramName.replace(/^[$]+/, '');
            if (!(paramName in msg)) {
                return;
            }

            var isUrlParam = url.indexOf(':' + paramName) !== -1;
            var valFormat = isUrlParam || format !== 'json' ? 'query' : format;
            var val;
            if (valFormat !== 'json' && typeof msg[paramName] === 'object') {
                try {
                    msg[paramName] = JSON.stringify(msg[paramName]);
                    val = encodeURIComponent(msg[paramName]);
                } catch (ex) {
                    util.error('httpSend: Error while converting object to JSON: ' + (ex.message || ex));
                }
            } else {
                val = valFormat === 'json' ? msg[paramName] : encodeURIComponent(msg[paramName]);
            }

            if (isUrlParam) {
                url = url.replace(':' + paramName, val);
            } else {
                if (format === 'json') {
                    ret.query[paramName] = val;
                } else {
                    ret.query.push(paramName + '=' + val);
                }
            }
        });
        ret.url = url;
        return ret;
    }

    /**
     *  Send an HTTP request to the server and pass the result to a callback.
     *  @param {Object} msg parameters to send as the request body
     *  @param {Object} block parameter definition from the `routes.json` file that
     *          contains validation rules
     *  @param {Function} callback function to be called when the request returns.
     *          If the the request returns with an error, the error is passed to
     *          the callback as its first argument (NodeJS-style).
     **/
    Client.prototype.httpSend = function (msg, block, callback) {
        var self = this;
        var method = block.method.toLowerCase();
        var hasBody = ('head|get|delete'.indexOf(method) === -1);
        var format = hasBody && this.constants.requestFormat ? this.constants.requestFormat : 'query';
        var obj = _getQueryAndUrl(msg, block, format);
        var query = obj.query;
        var protocol = this.config.protocol || this.constants.protocol || 'http';
        var host = this.config.host || this.constants.host;
        var pathPrefix = protocol + '://' + host;
        var url = this.config.url ? pathPrefix + this.config.url + obj.url : pathPrefix + obj.url;

        var path = (!hasBody && query.length) ? url + '?' + query.join('&') : url;
        var headers = {};
        if (hasBody) {
            if (format === 'json') {
                query = JSON.stringify(query);
            } else {
                query = query.join('&');
            }
            headers['content-type'] = format === 'json' ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded; charset=utf-8';
        }
        if (this.auth) {
            switch (this.auth.type) {
            case 'oauth':
                path += (path.indexOf('?') === -1 ? '?' : '&') +
                    'access_token=' + encodeURIComponent(this.auth.token);
                break;
            case 'token':
                headers.authorization = 'token ' + this.auth.token;
                break;
            default:
                break;
            }
        }

        if (!msg.headers) {
            msg.headers = {};
        }
        Object.keys(msg.headers).forEach(function (header) {
            var headerLC = header.toLowerCase();
            //disabled because it overrides also the 'accept' header
//      if (self.requestHeaders.indexOf(headerLC) === -1) {
//        return;
//      }
            headers[headerLC] = msg.headers[header];
        });

        if (this.debug) {
            util.log('REQUEST');
        }

        var xhr = new XMLHttpRequest();
        xhr.open(method, path, true);
        Object.keys(headers).forEach(function (header) {
            xhr.setRequestHeader(header, headers[header]);
        });
        xhr.onreadystatechange = function () {
            if (self.debug) {
                util.log('STATUS: ' + xhr.status);
            }
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) {
                    var res = {
                        headers: {},
                        data: null
                    };
                    var headersSplit = xhr.getAllResponseHeaders().split('\n');
                    for (var i = 0, length = headersSplit.length; i < length; i = i + 1) {
                        var header = headersSplit[i];
                        if (header !== '' && header.indexOf(':') !== -1) {
                            var dividerIndex = header.indexOf(':');
                            var key = header.substring(0, dividerIndex).trim().toLowerCase();
                            res.headers[key] = header.substring(dividerIndex + 1).trim();
                        }
                    }
                    res.data = xhr.responseText;
                    callback(null, res);
                } else if (xhr.status >= 400 && xhr.status < 600 || xhr.status < 10) {
                    util.error(xhr.status, xhr.responseText); //TODO use HttpError instead
                    callback(new HttpError(xhr.responseText, xhr.status), null);
                }
            }
        };
        xhr.send(hasBody ? query : null);
    };
    return Client;
});