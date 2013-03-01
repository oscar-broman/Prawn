// TODO: Remove error logging and throw errors instead

/*
  Exports:
  - getWinetricksPackages(callback)
  - getWineVersion(callback)
  - init(callback)
  - isWindowsPath(path)
  - processExiting(done)
  - spawn(command, args, options)
  - startServer(callback)
  - stopServer()
  - unixPath(paths, callback)
  - windowsPath(paths, callback)
  - winePath(type, paths, callback)
*/

'use strict';

var childProcess = require('child_process');
var os = require('os');
var util = require('util');
var path = require('path');
var async = require('async');
var fs = require('fs');

var _initialized = false;
var _server;
var _binary = 'wine';
var _isWindows = process.platform === 'win32';
var _exiting = false;

function _init(fn) {
  if (_initialized) {
    fn();
    
    return;
  }
  
  _initialized = true;
  
  if (_isWindows) return;
  
  var child = childProcess.spawn('wine.bin', ['--version']);
  var output = '';
  
  child.stdout
    .on('data', function(data) {
      output += data;
    })
    .on('end', function () {
      output = output.trim();
      
      if (output) {
        _binary = 'wine.bin';
      }
      
      versionCheck();
    });
  
    function versionCheck() {
      _getWineVersion(function(err, version) {
        if (_exiting) return;
        if (err) fn(err);
    
        if (!version) {
          console.log('Error: Wine is required.');
          console.log('1. If you don\'t already have homebrew installed, get it here: http://mxcl.github.com/homebrew/');
          console.log('2. run: brew install wine');
    
          process.emit('quit');
        }
    
        fn();
        
        _getWinetricksPackages(function(err, packages) {
          if (_exiting) return;
          
          if (err) {
            if (err.exitCode === 127) {
              console.log('Warning: It doesn\'t seem like you have winetricks installed.');
              
              switch (os.platform()) {
                case 'darwin':
                  console.log('         One of the following commands might work:');
                  console.log('           brew install winetricks');
                  console.log('           port install winetricks');
                  console.log('           fink install winetricks');
                  
                  break;
                
                case 'linux':
                  console.log('         Install "winetricks" - you could try using your package manager (apt-get, aptitude, ..).');
                  
                  break;
              }
            } else {
              console.error(err.message);
            }
            
            process.emit('quit');
            
            return;
          }
          
          if (packages.indexOf('vcrun2005') === -1 || packages.indexOf('vcrun2010') === -1) {
            console.log('Warning: It doesn\'t seem like you have vcrun2005 and vcrun2010 installed.');
            console.log('         This is how you install it:');
            console.log('           winetricks vcrun2005 vcrun2010');
          }
        });
      });
    }
}

function _startServer(fn) {
  if (_isWindows) return fn && fn(null);
  
  process.on('exiting', _processExiting);
  
  _init(function (err) {
    if (err) return fn && fn(err);
    
    _server = childProcess.spawn('wineserver', ['-f', '-p']);
    
    _server.on('exit', function(code) {
      _server = null;
    });
    
    if (fn) {
      fn(null);
    }
  });
}

function _stopServer() {
  if (_isWindows) return;
  
  process.removeListener('exiting', _processExiting);
  
  if (_server) {
    _server.kill();
    
    _server = null;
  }
}

function _processExiting(done) {
  _exiting = true;
  
  _stopServer();
  
  done();
}

function _getWinetricksPackages(fn) {
  var child = childProcess.spawn('winetricks', ['list-installed']);
  var output = '';
  var endNext = false;
  
  child.stdout
    .on('data', function (data) {
      output += data;
    })
    .on('end', function (code) {
      output = output.trim();
      output = output.toLowerCase();
      output = output.split(/\s+/);
      
      if (endNext) {
        fn(null, output);
      } else {
        endNext = true;
      }
    });
  
  child.on('exit', function(code) {
    if (code !== 0) {
      var error = new Error('winetricks exited with code ' + code + '.');
      
      error.exitCode = code;
      
      fn(error);
      
      endNext = false;
    } else if (endNext) {
      fn(null, output);
    } else {
      endNext = true;
    }
  });
}

function _getWineVersion(fn) {
  var child = childProcess.spawn('wine', ['--version']);
  var output = '';
  
  child.stdout
    .on('data', function(data) {
      output += data;
    })
    .on('end', function () {
      output = output.trim();
      
      fn(null, output || null);
    });
}

function _isWindowsPath(path) {
  return (/^[a-z]:(\\|\/|$)/i.test(path));
}

function _winePath(type, paths, fn) {
  var single = !util.isArray(paths);
  
  if (single) {
    paths = [paths];
  }
  
  var child = childProcess.spawn('winepath', ['--' + type].concat(paths));
  var out = '';
  
  child.stdout
    .on('data', function (data) {
      out += data;
    })
    .on('end', function () {
      var newPaths = out.trim();
    
      if (newPaths) {
        newPaths = newPaths.split(/\r?\n/);
        
        if (newPaths.length !== paths.length) {
          fn(new Error('winepath returned an incorrect number of paths.'));
        } else {
          if (type === 'unix') {
            var operations = [];

            // Winepath output will be something like ~/.wine/dosdevices/z:/...
            // Try to figure out the real path
            newPaths.forEach(function(newPath) {
              operations.push(function(fn) {
                fs.realpath(newPath, function(err, resolvedPath) {
                  if (err) {
                    // Path doesn't exist?
                    if (err.code === 'ENOENT') {
                      // Try to resolve the folder's path
                      fs.realpath(path.dirname(newPath), function(err, resolvedPath) {
                        // Still nothing? Give up..
                        if (err) return fn(null, newPath);
                        
                        fn(null, path.join(resolvedPath, path.basename(newPath)));
                      });
                    } else {
                      fn(err);
                    }
                    
                    return;
                  }
                  
                  fn(null, resolvedPath);
                });
              });
            });
            
            async.parallel(operations, function(err, results) {
              if (err) return fn(err);
              
              if (single) {
                fn(null, results[0]);
              } else {
                fn(null, results);
              }
            });
          } else {
            if (single) {
              fn(null, newPaths[0]);
            } else {
              fn(null, newPaths);
            }
          }
        }
      } else {
        fn(new Error('winepath failed.'));
      }
    });
}

function _windowsPath(paths, fn) {
  if (_isWindows) {
    return fn(null, paths);
  }
  
  _winePath('windows', paths, fn);
}

function _unixPath(paths, fn) {
  _winePath('unix', paths, fn);
}

function _spawn(command, args, options) {
  if (_isWindows) {
    return childProcess.spawn(command, args, options);
  }
  
  args = [command].concat(args || []);
  
  return childProcess.spawn(_binary, args, options);
}


exports.startServer = _startServer;
exports.stopServer = _stopServer;
exports.windowsPath = _windowsPath;
exports.unixPath = _unixPath;
exports.isWindowsPath = _isWindowsPath;
exports.spawn = _spawn;
