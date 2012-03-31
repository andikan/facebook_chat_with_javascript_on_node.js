// -*-  tab-width:4  -*-

/*
 * Copyright (c) 2011 Dhruv Matani, Anup Kalbalia
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

var dutil       = require('./dutil.js');
var us          = require('underscore');
var helper      = require('./helper.js');
var http        = require('http');
var url         = require('url');
var path        = require('path');
var EventPipe   = require('eventpipe').EventPipe;

var filename    = "[" + path.basename(path.normalize(__filename)) + "]";
var log         = require('./log.js').getLogger(filename);

var BoshRequestParser = require('./bosh-request-parser').BoshRequestParser;

function HTTPServer(port, host, stat_func, bosh_request_handler, http_error_handler,
                    bosh_options) {

    // All request handlers return 'false' on successful handling
    // of the request and 'undefined' if they did NOT handle the
    // request. This is according to the EventPipe listeners API
    // expectation.
    function handle_get_bosh_request(req, res, u) {
        var ppos = u.pathname.search(bosh_options.path);
        if (req.method === 'GET' && ppos !== -1 && u.query.hasOwnProperty('data')) {
            res = new helper.JSONPResponseProxy(req, res);
            var bosh_request_parser = new BoshRequestParser();
            var err = false;
            if (!bosh_request_parser.parse(u.query.data)) {
                err = new Error("Parse Error");
            }
            if (err) {
                req.destroy();
            } else {
                res.request_headers = req.headers;
                bosh_request_handler(res, bosh_request_parser.parsedBody);
            }
            return false;
        }
    }

    function handle_post_bosh_request(req, res, u) {
        var ppos = u.pathname.search(bosh_options.path);
        if (req.method !== 'POST' || ppos === -1) {
            return;
        }

        var end_timeout;
        var req_body_length = 0;
        var bosh_request_parser = new BoshRequestParser();

        var _on_end_callback = us.once(function (err) {
            if (end_timeout) {
                clearTimeout(end_timeout);
            }

            if (err) {
                log.warn("%s - destroying connection from '%s'", err, req.socket.remoteAddress);
                req.destroy();
            } else {
                var body = bosh_request_parser.parsedBody;
                log.debug("RECD: %s", body);
                res.request_headers = req.headers;
                bosh_request_handler(res, body);
                bosh_request_parser.end();
            }

            bosh_request_parser = null;
        });

        // Timeout the request of we don't get an 'end' event within
        // 20 sec of the request being made.
        end_timeout = setTimeout(function () {
            _on_end_callback(new Error("Timed Out"));
        }, 20 * 1000);
        
        req.on('data', function (d) {
            req_body_length += d.length;
            if (req_body_length > bosh_options.MAX_DATA_HELD) {
                _on_end_callback(new Error("max_data_held exceeded"));
            }
            else if (!bosh_request_parser.parse(d)) {
                _on_end_callback(new Error("Parse Error"));
            }
        })
        .on('end', function () {
            _on_end_callback();
        })
        .on('error', function (ex) {
            log.error("Exception '" + ex.toString() + "' while processing request");
            log.error("Stack Trace: %s\n", ex.stack);
        });
        return false;
    }

    function handle_options(req, res, u) {
        if (req.method === 'OPTIONS') {
            res.writeHead(200, bosh_options.HTTP_OPTIONS_RESPONSE_HEADERS);
            res.end();
            return false;
        }
    }

    function handle_get_favicon(req, res, u) {
        if (req.method === 'GET' && u.pathname === '/favicon.ico') {
            res.writeHead(303, {
                'Location': 'http://xmpp.org/favicon.ico'
            });
            res.end();
            return false;
        }
    }

    function handle_get_statistics(req, res, u) {
        var ppos = u.pathname.search(bosh_options.path);
        if (req.method === 'GET' && ppos !== -1 && !u.query.hasOwnProperty('data')) {
            res.writeHead(200, bosh_options.HTTP_GET_RESPONSE_HEADERS);
            var stats = stat_func();
            res.end(stats);
            return false;
        }
    }

    //
    // http://code.google.com/p/node-xmpp-bosh/issues/detail?id=22
    // Supporting cross-domain requests through the addition of flash. This will be necessary
    // if you use the plug strophe.flxhr.js for the library strophe.
    //
    function handle_get_crossdomainXML(req, res, u) {
        if (req.method === 'GET' && req.url === "/crossdomain.xml") {
            res.writeHead(200, bosh_options.HTTP_GET_RESPONSE_HEADERS);
            var crossdomain = '<?xml version="1.0"?>';
            crossdomain += '<!DOCTYPE cross-domain-policy SYSTEM "http://www.macromedia.com/xml/dtds/cross-domain-policy.dtd">';
            crossdomain += '<cross-domain-policy>';
            crossdomain += '<site-control permitted-cross-domain-policies="all"/>';
            crossdomain += '<allow-access-from domain="*" to-ports="' + port + '" secure="true"/>';
            crossdomain += '<allow-http-request-headers-from domain="*" headers="*" />';
            crossdomain += '</cross-domain-policy>';
            res.end(crossdomain);
            return false;
        }
    }
    
    function handle_unhandled_request(req, res, u) {
        log.trace("Invalid request, method: %s path: %s", req.method, u.pathname);
        var _headers = { };
        dutil.copy(_headers, bosh_options.HTTP_POST_RESPONSE_HEADERS);
        _headers['Content-Type'] = 'text/plain; charset=utf-8';
        res.writeHead(404, _headers);
        res.end();
        return false;
    }

    // TODO: Read off the Headers request from the request and set that in the
    // response.

    var router = new EventPipe();
    router.on('request', handle_post_bosh_request, 1)
        .on('request', handle_get_bosh_request, 2)
        .on('request', handle_options, 3)
        .on('request', handle_get_favicon, 4)
        .on('request', handle_get_statistics, 5)
        .on('request', handle_get_crossdomainXML, 6)
        .on('request', function(req, res, u) {
				if (req.method === 'GET' 
					&& (u.pathname === '/basic.html' || 
						u.pathname === '/facebook.html' ||
						u.pathname === '/facebook.js' || 
						u.pathname === '/strophe.js')) {
							
					if(u.pathname.search('.html')){
						res.writeHead(200,
							{'Content-Type': 'text/html; charset=UTF-8'}
							);						
					}else {
						res.writeHead(200,
							{'Content-Type': 'text/javascript; charset=UTF-8'}
							);
					}
					
					var fs = require('fs');
					var file_path = require.resolve(".." + u.pathname);
					var file_content = fs.readFileSync(file_path);
					res.end(file_content);
					
					return false;
				}
			}
			, 6)
        .on('request', handle_unhandled_request, 7);

    function http_request_handler(req, res) {
        var u = url.parse(req.url, true);
        log.trace("Processing %s request at location: %s", req.method, u.pathname);
        router.emit('request', req, res, u);
    }

    // Initialize
    var server = http.createServer(http_request_handler);
    server.on('error', http_error_handler);
    server.listen(port, host);

    this.http_server = server;
}

exports.HTTPServer = HTTPServer;
