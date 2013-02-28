/*
  Exports:
  - invokeCompiler(inputFile, flags, callback)
  - compileText(inputText, flags, callback)
*/

'use strict';

var tmp = require('tmp');
var childProcess = require('child_process');
var fs = require('fs');
var wine = require('./wine');
var _ = require('underscore');
var util = require('util');
var async = require('async');
var path = require('path');

var _isWindows = process.platform === 'win32';
var _invocationOptions = ['maxTime', 'errorPathsRelativeTo'];

// Can be used as keys where flags are to be given
var _flagAliases = {
  dataAlignment:      'A',  crossReference:     'r',
  outputAsm:          'a',  stackHeapSize:      'S',
  compactEncoding:    'C',  skipLines:          's',
  codepage:           'c',  tabsize:            't',
  workingDirectory:   'D',  verbosityLevel:     'v',
  debugLevel:         'd',  disableWarning:     'w',
  errorFile:          'e',  amSizeLimit:        'X',
  notifyHWND:         'H',  amDataSizeLimit:    'XD',
  includeDirectory:   'i',  backslashEscape:    '\\',
  outputLst:          'l',  caretEscape:        '^',
  outputFile:         'o',  requireSemicolons:  ';',
  optimizationLevel:  'O',  requireParentheses: '(',
  prefixFile:         'p'
};

// string: -flag=value
// path:   paths will be converted for Wine
// bool:   -flag+ or -flag-
// enable: adds -flag only if value is truthy
// Any other flags are treated as pre-defined constants (i.e. sym=value).
var _flagTypes = {
  A:    'string',  r:    'path',
  a:    'enable',  S:    'string',
  C:    'bool',    s:    'string',
  c:    'string',  t:    'string',
  D:    'path',    v:    'string',
  d:    'string',  w:    'string',
  e:    'path',    X:    'string',
  H:    'string',  XD:   'string',
  i:    'path',    '\\': 'enable',
  l:    'enable',  '^':  'enable',
  o:    'string',  ';':  'bool',
  O:    'string',  '(':  'bool',
  p:    'path'
};

// Error constructor
function PawncError(info) {
  this.file = info.file;
  this.startLine = info.startLine;
  this.endLine = info.endLine;
  this.type = info.type;
  this.number = info.number;
  this.message = info.message;
  this.fatal = info.fatal || false;
}

PawncError.prototype.toString = function() {
  var errstr = '';
  
  errstr += this.file;
  
  if (this.startLine === this.endLine) {
    errstr += '(' + this.startLine + ') : ';
  } else {
    errstr += '(' + this.startLine + ' -- ' + this.endLine + ') : ';
  }
  
  if (this.fatal) {
    errstr += 'fatal ';
  }
  
  errstr += this.type + ' ';
  errstr += this.number + ': ';
  errstr += this.message;
  
  return errstr;
};

// Parse an error string
function _parseError(errstr) {
  var match = errstr.match(/^\s*(.+?)\((\d+)(?: -- (\d+))?\) : (warning|error|fatal error) (\d+): (.*?)\s*$/);
  
  if (match) {
    var error = {
      file: match[1],
      startLine: +match[2],
      endLine: match[3] === undefined ? +match[2] : +match[3],
      type: match[4],
      number: +match[5],
      message: match[6] || ''
    };
    
    if (error.type === 'fatal error') {
      error.fatal = true;
      error.type = 'error';
    }
    
    return new PawncError(error);
  }
  
  return null;
}

// Build an array of flags ready to be used in childProcess.spawn (thus also wine.spawn).
// { debugLevel: 3, outputAsm: true, outputLst: false, includeDirectory: '/home/user/folder', HELLO: 'world' }
// ->
// [ '-d=3', '-a', '-i=Z:\\home\\user\\someDir', 'HELLO=world' ]
function _buildFlags(flags, fn) {
  var rawFlags = [];
  var pathFlags = [];
  var pathValues = [];
  
  for (var flag in flags) {
    var value, type;
    
    value = flags[flag];
    flag = flag.replace(/^-/, '');
    flag = _flagAliases[flag] || flag;
    type = _flagTypes[flag];
    
    // If a value is an array, add a flag for each entry.
    // Useful for the -w flag, which can be used multiple times.
    if (util.isArray(value)) {
      for (var i = 0, len = value.length; i < len; i++) {
        addFlag(type, value[i]);
      }
    } else {
      addFlag(type, value);
    }
  }
  
  function addFlag(type, value) {
    switch (type) {
      case 'path':
        
        if (_isWindows || wine.isWindowsPath(value)) {
          rawFlags.push('-' + flag + '=' + value);
        } else {
          // Will be converted
          pathFlags.push(flag);
          pathValues.push(value);
        }
        
        break;
      
      case 'enable':
        
        if (value) {
          rawFlags.push('-' + flag);
        }
        
        break;
      
      case 'bool':
        
        rawFlags.push('-' + flag + (value ? '+' : '-'));
        
        break;

      case undefined:
        
        rawFlags.push(flag + '=' + value);
        
        break;
      
      case 'string':
        
        rawFlags.push('-' + flag + '=' + value);
        
        break;
    }
  }
  
  if (pathFlags.length) {
    wine.windowsPath(pathValues, function(err, winePaths) {
      if (err) return fn(err);
      
      for (var i = 0, len = pathFlags.length; i < len; i++) {
        rawFlags.push('-' + pathFlags[i] + '=' + winePaths[i]);
      }
      
      fn(null, rawFlags);
    });
  } else {
    fn(null, rawFlags);
  }
}

// Invoke the compiler.
function _invokeCompiler(inputFile, flags, fn) {
  flags = flags || {};
  
  var options = _.pick(flags, _invocationOptions);
  flags = _.omit(flags || {}, _invocationOptions);
  
  // If null, stderr will output errors
  var errorFile = flags.errorFile || flags.e || flags['-e'] || null;
  
  // Figure out the output  file
  var outputFile = flags.outputFile || flags.o || flags['-o'] || null;
  
  if (!outputFile) {
    outputFile = inputFile.replace(/\.[a-z0-9]+/i, '');
    
    if (flags.outputLst || flags.l || flags['-l']) {
      outputFile += '.lst';
    } else if (flags.outputAsm || flags.a || flags['-a']) {
      outputFile += '.asm';
    } else {
      outputFile += '.amx';
    }
  }
  
  // Build the flags
  var operations = {
    flags: async.apply(_buildFlags, flags)
  };
  
  // Convert the inputFile path if needed
  if (!_isWindows && !wine.isWindowsPath(inputFile)) {
    operations.winePath = async.apply(wine.windowsPath, inputFile);
  }
  
  async.parallel(operations, function(err, results) {
    if (err) return fn(err);
    
    var inputWineFile = results.winePath || inputFile;
    flags = results.flags;
    
    // Spawn the compiler
    var child = wine.spawn('./bin/pawncc.exe', [inputWineFile].concat(flags));
    
    // Kill the compiler after 15000ms (or options.maxTime) as it probably crashed.
    var killTimeout = setTimeout(function() {
      killTimeout = null;
      
      // No mercy
      child.kill('SIGKILL');
      
      fn(new Error('The compiler stopped responding.'));
    }, options.maxTime || 15000);
    
    var stdout = '';
    var stderr = '';
    
    child.stdout.on('data', function(data) {
      stdout += data;
    });
    
    if (!errorFile) {
      child.stderr.on('data', function(data) {
        stderr += data;
      });
    }
    
    // Wait for streams and child process to end
    async.parallel([
      function(fn) {
        child.on('exit', function(code) {
          fn(null, code);
        });
      },
      function(fn) {
        child.stdout.on('end', function() {
          fn(null);
        });
      },
      function(fn) {
        if (errorFile) {
          fs.readFile(errorFile, function(err, data) {
            if (!err) {
              stderr = data.toString();
            }
            
            fn(null);
          });
        } else {
          child.stderr.on('end', function() {
            fn(null);
          });
        }
      }
    ], function(err, results) {
      // Was the process killed?
      if (killTimeout === null) {
        // fn has already been invoked
        return;
      } else {
        clearTimeout(killTimeout);
      }
      
      if (results[0] > 1) {
        return fn(new Error('The compiler encountered an error (' + results[0] + ')'));
      }
      
      if (err) return fn(err);
      
      var errors = [];
      var windowsPaths = [];
      
      stdout = stdout.trim().replace(/[\r\n]+/g, '\n');
      stderr = stderr.trim().replace(/[\r\n]+/g, '\n');
      
      // Extract all the information from error messages
      stderr.split('\n').forEach(function(line) {
        var error = _parseError(line);
        
        if (error) {
          errors.push(error);
          
          // Fill up windowsPaths with paths to be converted
          if (!_isWindows) {
            if (wine.isWindowsPath(error.file)) {
              if (windowsPaths.indexOf(error.file) === -1) {
                windowsPaths.push(error.file);
              }
            }
            
            var match = error.message.match(/file: "?([^"]+)"?/);
            
            if (match) {
              if (windowsPaths.indexOf(match[1]) === -1) {
                windowsPaths.push(match[1]);
              }
            }
          }
        }
      });
      
      if (!windowsPaths.length) {
        fn(null, {
          errors: errors,
          outputFile: outputFile
        });
      } else {
        wine.unixPath(windowsPaths, function(err, paths) {
          if (err) return fn(err);
          
          if (options.errorPathsRelativeTo) {
            fs.realpath(options.errorPathsRelativeTo, function(err, realPath) {
              if (err) return fn(err);
              
              for (var i = 0, len = paths.length; i < len; i++) {
                paths[i] = path.relative(realPath, paths[i]);
              }
              
              replacePaths();
            });
          } else {
            replacePaths();
          }
          
          // Replace the paths in file paths and messages
          function replacePaths() {
            errors.forEach(function(error) {
              var i = windowsPaths.indexOf(error.file);
            
              if (i !== -1) {
                error.file = paths[i];
              }
            
              error.message = error.message.replace(/file: ("?)([^"]+)("?)/, function(match, q1, file, q2) {
                var i = windowsPaths.indexOf(file);
              
                if (i !== -1) {
                  return 'file: ' + q1 + paths[i] + q2;
                }
              
                return match;
              });
            });
          
            fn(null, {
              errors: errors,
              outputFile: outputFile
            });
          }
        });
      }
    })
  });
}

function _compileText(text, flags, fn) {
  flags = flags || {};
  
  if (!(flags.outputFile || flags['o'] || flags['-o'])) {
    return fn(new Error('Output file flag must be provided.'));
  }
  
  tmp.file({
    postfix: '.pwn'
  }, function (err, pwnFile) {
    if (err) return fn(err);
    
    function cleanup() {
      fs.unlink(pwnFile);
    }
    
    fs.writeFile(pwnFile, text, function(err) {
      if (err) return cleanup(), fn(err);
      
      flags.errorPathsRelativeTo = path.dirname(pwnFile);
      
      _invokeCompiler(pwnFile, flags, function(err, result) {
        if (err) return cleanup(), fn(err);
        
        cleanup();
        fn(null, result);
      });
    });
  });
}


exports.invokeCompiler = _invokeCompiler;
exports.compileText = _compileText;