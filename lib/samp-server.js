// Finished, but not hooked up by anything.
// In future versions, this will be used for unit testing.
'use strict';

var wine = require('./wine');
var _ = require('underscore');
var tmp = require('tmp');
var async = require('async');
var rimraf = require('rimraf');
var path = require('path');
var fs = require('fs-extra');
var stream = require('stream');
var watchr = require('watchr');

var _runningServers = [];
var _plugins = {
  crashdetect: {
    description: 'Reports runtime errors and server crashes.'
  }
};

process.on('exiting', function () {
  for (var i = 0; i < _runningServers.length; i++) {
    _runningServers[i].kill('SIGKILL');
  }
});

function _setupTemporaryServer(options, fn) {
  if (!options.amxPath) {
    return fn(new Error('Requires amxPath in the options.'));
  }

  options = _.extend({
    rconPassword: 'changedyou',
    maxPlayers: 20,
    port: 7777,
    hostName: 'Unnamed SA-MP Server',
    announce: false,
    query: true,
    maxNpc: 0,
    logTimeFormat: '[%H:%M:%S]',
    plugins: []
  }, options);

  var plugins = '';

  for (var i = 0; i < options.plugins.length; i++) {
    if (!_plugins[options.plugins[i]]) {
      return fn(new Error('Unregistered plugin: ' + options.plugins[i]));
    } else {
      plugins += ' ..\\..\\plugins\\' + options.plugins[i] + '.dll';
    }
  }

  var cfg = [
    'rcon_password ' + options.rconPassword,
    'maxplayers ' + options.maxPlayers,
    'port ' + options.port,
    'hostname ' + options.hostName,
    'gamemode0 gm',
    'announce ' + (+options.announce),
    'query ' + (+options.query),
    'maxnpc ' + options.maxNpc,
    'logtimeformat ' + options.logTimeFormat,
    'plugins' + plugins
  ].join('\n');

  tmp.dir({
    dir: path.join('bin', 'server')
  }, function(err, tmpDir) {
    function cleanup() {
      rimraf(tmpDir, function(err) {});
    }

    var amxAction = options.moveAmx ? fs.rename : fs.copy;
    var amxPath = path.join(tmpDir, 'gamemodes', 'gm.amx');

    async.series([
      async.apply(fs.writeFile, path.join(tmpDir, 'server.cfg'), cfg),
      async.apply(fs.mkdir, path.join(tmpDir, 'gamemodes'), '700'),
      async.apply(fs.mkdir, path.join(tmpDir, 'scriptfiles'), '700'),
      async.apply(amxAction, options.amxPath, amxPath),
      async.apply(fs.chmod, amxPath, '700')
    ], function(err, results) {
      if (err) {
        cleanup();
        return fn(err);
      }

      fn(null, tmpDir);
    });
  });
}

function _runServer(dir, options, fn) {
  options = _.extend({
    binary: path.join('bin', 'server', 'samp-server.exe'),
    maxRunTime: false
  }, options);

  options.binary = path.resolve(process.cwd(), options.binary);

  var logPath = path.join(dir, 'server_log.txt');
  var logStream, logWatcher, logFd = null;

  fs.stat(logPath, function(err, stats) {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.writeFile(logPath, '', function(err) {
          if (err) return fn(err);

          beginLogStream(0);
        });
      } else {
        fn(err);
      }
    } else {
      beginLogStream(stats.size);
    }
  });

  function beginLogStream(prevPos) {
    fs.open(logPath, 'r', function(err, fd) {
      if (err) return fn(err);

      logFd = fd;

      logWatcher = watchr.watch({
        path: logPath,
        interval: 50,
        duplicateDelay: 50,
        listeners: {
          watching: function(err, watcherInstance, isWatching) {
            if (err) {
              this.close();
              return fn(err);
            }

            logStream = new stream.Stream();

            logStream.readable = true;
            logStream.writable = true;

            fn(null, {
              outputStream: logStream
            });

            startServer();
          },
          change: function(changeType, filePath, currentStat, previousStat) {
            if (changeType === 'update') {

              var bytesToRead = currentStat.size - prevPos;
              var buffer = new Buffer(bytesToRead);

              fs.read(logFd, buffer, 0, bytesToRead, prevPos, function(err, bytesRead, buffer) {
                logStream.emit('data', buffer.toString());
              });

              prevPos = currentStat.size;
            } else if (changeType === 'delete') {
              this.close();
            }
          }
        }
      });
    });
  }

  function startServer() {
    var server, killTimer;

    if (options.maxRunTime) {
      var killTimer = setTimeout(function() {
        var alive = true;

        killTimer = null;

        // Try ending it nicely first
        server.kill('SIGTERM');

        server.on('exit', function() {
          alive = false;
        });

        // If it's not closed within 1 second, kill it
        setTimeout(function() {
          if (alive) {
            server.kill('SIGKILL');
          }
        }, 1000);
      }, options.maxRunTime);
    }

    server = wine.spawn(options.binary, [], {
      cwd: dir
    });

    _runningServers.push(server);

    server.on('exit', function() {
      var idx = _runningServers.indexOf(server);

      if (idx !== -1) {
        _runningServers.splice(idx, 1);
      }

      logWatcher.close();

      if (logFd !== null) {
        fs.close(logFd);
      }

      setTimeout(function() {
        logStream.emit('end');
      }, 100);
    });
  }
}

exports.setupTemporaryServer = _setupTemporaryServer;
exports.runServer = _runServer;