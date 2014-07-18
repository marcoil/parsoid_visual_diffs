#!/usr/bin/env node
"use strict";

var http = require( 'http' ),
	request = require('request'),
	cluster = require('cluster'),
	qs = require( 'querystring' ),
	exec = require( 'child_process' ).exec,
	config = require( process.argv[2] || './config.js' ),
	Util = require('../lib/differ.utils.js').Util,
	Differ = require('../lib/differ.js').VisualDiffer;

var commit, ctime,
	lastCommit, lastCommitTime, lastCommitCheck,
	repoPath = __dirname;

/**
 * Perform a HTTP request using the 'request' package, and retry on failures
 *
 * Only use on idempotent HTTP end points
 * @param {number} retries -- the number of retries to attempt
 * @param {object} paramOptions -- request options
 * @param {function} cb -- request cb: function(error, response, body)
 */
Util.retryingHTTPRequest = function (retries, requestOptions, cb) {
	var delay = 100, // start with 100ms
		errHandler = function (error, response, body) {
			if (error) {
				if (retries--) {
					console.error('HTTP ' + requestOptions.method + ' to \n' +
							(requestOptions.uri || requestOptions.url) + ' failed: ' + error +
							'\nRetrying in ' + (delay / 1000) + ' seconds.');
					setTimeout(function() { request(requestOptions, errHandler); }, delay);
					// exponential back-off
					delay = delay * 2;
					return;
				}
			}
			cb(error, response, body);
		};

	request(requestOptions, errHandler);
};

// deep clones by default.
Util.clone = function(obj, deepClone) {
	if (deepClone === undefined) {
		deepClone = true;
	}
	if ( Array.isArray(obj) ) {
		if ( deepClone ) {
			return obj.map(function(el) {
				return Util.clone(el, true);
			});
		} else {
			return obj.slice();
		}
	} else if ( obj instanceof Object && // only "plain objects"
				Object.getPrototypeOf(obj) === Object.prototype) {
		/* This definition of "plain object" comes from jquery,
		 * via zepto.js.  But this is really a big hack; we should
		 * probably put a console.assert() here and more precisely
		 * delimit what we think is legit to clone. (Hint: not
		 * tokens or DOM trees.) */
		var nobj = {};
		if ( deepClone ) {
			return Object.keys(obj).reduce(function(nobj, key) {
				nobj[key] = Util.clone(obj[key], true);
				return nobj;
			}, nobj);
		} else {
			return Object.assign(nobj, obj);
		}
	} else {
		return obj;
	}
};

var getTitle = function( cb ) {
	var requestOptions = {
		uri: 'http://' + config.server.host + ':' +
			config.server.port + '/title?commit=' + commit + '&ctime=' + encodeURIComponent( ctime ),
		method: 'GET'
	},
	retries = 10;

	var callback = function ( error, response, body ) {
		if (error || !response) {
			setTimeout( function () { cb( 'start' ); }, 15000 );
			return;
		}

		var resp;
		switch ( response.statusCode ) {
			case 200:
				resp = JSON.parse( body );
				cb( 'runTest', resp);
				break;
			case 404:
				console.log( 'The server doesn\'t have any work for us right now, waiting half a minute....' );
				setTimeout( function () { cb( 'start' ); }, 30000 );
				break;
			case 426:
				console.log( "Update required, exiting." );
				// Signal our voluntary suicide to the parent if running as a
				// cluster worker, so that it does not restart this client.
				// Without this, the code is never actually updated as a newly
				// forked client will still run the old code.
				if (cluster.worker) {
					cluster.worker.kill();
				} else {
					process.exit( 0 );
				}
				break;
			default:
				console.log( 'There was some error (' + response.statusCode + '), but that is fine. Waiting 15 seconds to resume....' );
				setTimeout( function () { cb( 'start' ); }, 15000 );
		}
	};

	Util.retryingHTTPRequest(10, requestOptions, callback );
};

var encodeXmlEntities = function( str ) {
	return str.replace( /&/g, '&amp;' )
			  .replace( /</g, '&lt;' )
			  .replace( />/g, '&gt;' );
};

function encodeAttribute (str) {
	return encodeXmlEntities(str)
		.replace(/"/g, '&quot;');
}

var jsonFormat = function(opts, err, diffData) {
	var out = {
		prefix: opts.wiki,
		title: opts.title
	};

	if (err) {
		out.err = err;
	} else {
		out.fails = Math.floor(diffData.misMatchPercentage);
		out.skips = Math.round((diffData.misMatchPercentage - out.fails)*100);
		out.time = diffData.analysisTime;
	}

	return out;
};

var runTest = function(cb, test) {
	var logger = config.opts.quiet ? function(){} : function(msg) { console.log(msg); };

	try {
		// Make a copy
		var opts = Util.clone(config.opts);
		opts.wiki = test.prefix;
		opts.title = test.title;
		opts = Util.computeOpts(opts);
		logger("Diffing " + test.prefix + ":" + test.title);
		Differ.genVisualDiff(opts, logger,
			function(err, diffData) {
				if (err) {
					console.error( "ERROR for " + test.prefix + ':' + test.title + ': ' + err );
				}
				cb( 'postResult', jsonFormat(opts, err, diffData), test, null );
			}
		);
	} catch (err) {
		console.error( "ERROR in " + test.prefix + ':' + test.title + ': ' + err );
		console.error( "stack trace: " + err.stack);
		cb( 'postResult', jsonFormat(opts, err), test, function() { process.exit( 1 ); } );
	}
};

/**
 * Get the current git commit hash.
 */
var getGitCommit = function( cb ) {
	var now = Date.now();

	if ( !lastCommitCheck || ( now - lastCommitCheck ) > ( 5 * 60 * 1000 ) ) {
		lastCommitCheck = now;
		exec( 'git log --max-count=1 --pretty=format:"%H %ci"', { cwd: repoPath }, function ( err, data ) {
			var cobj = data.match( /^([^ ]+) (.*)$/ );
			if (!cobj) {
				console.log("Error, couldn't find the current commit");
				cb(null, null);
			} else {
				lastCommit = cobj[1];
				// convert the timestamp to UTC
				lastCommitTime = new Date(cobj[2]).toISOString();
				//console.log( 'New commit: ', cobj[1], lastCommitTime );
				cb(cobj[1], lastCommitTime);
			}
		} );
	} else {
		cb( lastCommit, lastCommitTime );
	}
};

var postResult = function( result, test, finalCB, cb ) {
	getGitCommit( function ( newCommit, newTime ) {
		if (!newCommit) {
			console.log("Exiting, couldn't find the current commit");
			process.exit(1);
		}

		var requestOptions = {
			host: config.server.host,
			port: config.server.port,
			headers: { 'Content-Type': 'application/json' },
			path: '/result/' + encodeURIComponent( test.title ) + '/' + test.prefix,
			method: 'POST'
		};

		var req = http.request( requestOptions, function ( res ) {
			res.on( 'end', function () {
				if ( finalCB ) {
					finalCB();
				} else {
					cb( 'start' );
				}
			} );
			res.resume();
		} );

		var out = JSON.stringify({ results: result, commit: newCommit, ctime: newTime, test: test });
		console.warn("POSTING: " + out);
		req.write( out, 'utf8' );
		req.end();
	} );
};

var callbackOmnibus = function(which) {
	var args = Array.prototype.slice.call(arguments);
	var test;
	switch ( args.shift() ) {
		case 'runTest':
			test = args[0];
			console.log( 'Running a test on', test.prefix + ':' + test.title, '....' );
			args.unshift( callbackOmnibus );
			runTest.apply( null, args );
			break;

		case 'postResult':
			test = args[1];
			console.log( 'Posting a result for', test.prefix + ':' + test.title, '....' );
			args.push( callbackOmnibus );
			postResult.apply( null, args );
			break;

		case 'start':
			getGitCommit( function ( latestCommit ) {
				if ( latestCommit !== commit ) {
					console.log( 'Exiting because the commit hash changed' );
					process.exit( 0 );
				}

				getTitle( callbackOmnibus );
			} );
			break;

		default:
			console.assert(false, 'Bad callback argument: '+which);
	}
};

if ( typeof module === 'object' ) {
	module.exports.getTitle = getTitle;
	module.exports.runTest = runTest;
	module.exports.postResult = postResult;
}

if ( module && !module.parent ) {
	var getGitCommitCb = function ( commitHash, commitTime ) {
		commit = commitHash;
		ctime = commitTime;
		callbackOmnibus('start');
	};

	getGitCommit( getGitCommitCb );
}