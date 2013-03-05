'use strict';

var path = require('path');
var fs = require('fs');
var temp = require('temp');
var amx = require('./amx');
var pawnc = require('./pawnc');
var async = require('async');
var extensions = [];


var PAWNC_DIRSEP = '\\';
var PAWN_SYMBOL = /^[a-z_@][a-z0-9_@]*$/i;

// Load extensions
var extPath = path.join(__dirname, 'ext');

fs.readdirSync(extPath).forEach(function(file) {
  extensions.push(require(path.join(extPath, file)));
});

// Get the first parameter given
var inputFile = process.argv[2];

if (!inputFile) {
  console.log('Usage: prawn <file>');

  process.exit();
} else {
  // Make sure it exists
  try {
    inputFile = fs.realpathSync(inputFile);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error('Error: Unable to find "' + process.argv[2] + '"');

      process.exit();
    } else {
      throw e;
    }
  }
}

var tree = _buildIncludeTree(inputFile, './include');
var entryFile = _saveIncludeTree('temp', tree);

// Compile LST file
if (fs.existsSync('test.lst')) {
  fs.unlinkSync('test.lst');
}

pawnc.invokeCompiler(entryFile, {
  includeDirectory: 'include',
  workingDirectory: 'temp',
  debugLevel: 2,
  tabsize: 4,
  outputLst: true,
  requireSemicolons: true,
  requireParentheses: true,

  PRAWN: true
}, function(err, result) {
  if (err) throw err;

  // Output errors, if any
  result.errors.forEach(function(error) {
    console.log(error.toString());
  });

  if (!fs.existsSync(result.outputFile) || !fs.statSync(result.outputFile).size) {
    console.error('Error: Failed to preprocess the script');

    try {
      fs.unlinkSync(result.outputFile);
    } catch (e) {}

    process.exit();
  }

  var script = fs.readFileSync(result.outputFile).toString();

  _parseLst(script);

  //fs.unlinkSync(result.outputFile);
});

// TODO: Deal with the script as a buffer instead of a huge string
function _parseLst(script) {
  // Remove any #endinput directives
  script = script.replace(/^\s*#endinput\s*?$/gm, '');

  // Add newlines before #file. The Pawn compiler doesn't always do this.
  script = script.replace(/#file ((?:[a-z]:[\/\\])?[^<>:"|?*]+?)$/img, '\n$&');

  // Skip the first compiler directives
  script = script.substr(script.indexOf('#file'));

  // Run extensions
  var operations = [];

  extensions.forEach(function(ext) {
    if (ext.parseScript) {
      operations.push(function(fn) {
        ext.parseScript(script, function(err, newScript) {
          if (err) return fn(err);

          script = newScript;

          fn(null);
        });
      });
    }
  });

  async.series(operations, function(err, results) {
    if (err) throw err;

    _compileLst(script);
  });
}

function _compileLst(script) {
  // Split the script up into an tree-like structure based on #file directives.
  // This is not perfect - circular inclusions will not work, and how well relative
  // paths work is not fully tested.
  // TODO: Convert all paths to absolute paths
  // TODO: Don't create substrings - pass around offsets instead.
  // TODO: Stop creating a bunch of files containing only newlines and #line directives
  function parse(script, recursion, includedBy) {
    // Must begin with #file
    if (script.substr(0, 6) !== '#file ') {
      throw new Error('Expected first line to be a #file directive');
    }

    // Avoid crashing
    if (recursion === undefined) {
      recursion = 0;
    } else if (recursion > 100) {
      throw new Error('Recursion exceeded 100');
    }

    // The first #file
    var outerFile = script.substr(6, script.search(/[\r\n]/) - 6);
    var outerPos = 6 + outerFile.length;

    // The script will be in this array
    var fragments = [
      // First fragment is always filename
      outerFile,

      // For debugging
      '// ' + outerFile + '\n'
    ];

    if (includedBy) {
      fragments.push('// Included by ' + includedBy + '\n');
    }

    // Search for all #line and #file directives
    var match, re = /#file ((?:[a-z]:[\/\\])?[^<>:"|?*]+?)$/img;

    re.lastIndex = outerPos;

    while ((match = re.exec(script))) {
      if (outerPos < match.index) {
        fragments.push(script.substr(outerPos, match.index - outerPos));
      }

      var startIndex = match.index;

      // Find outerFile again
      while ((match = re.exec(script))) {
        if (match[1] === outerFile) {
          // Parse the included file
          fragments.push(
            parse(
              script.substr(startIndex, match.index - startIndex),
              recursion + 1,
              match[1]
            )
          );

          break;
        }
      }

      if (match) {
        outerPos = re.lastIndex;
      } else {
        break;
      }
    }

    if (outerPos !== script.length) {
      fragments.push(script.substr(outerPos));
    }

    return fragments;
  }

  script = parse(script);

  // TODO: Use a proper temp dir. Might not do this for a while as this is useful for testing.
  var dir = 'temp';

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  } else {
    var removeRe = /\d+\.inc|output\.amx/;

    fs.readdirSync(dir).forEach(function(file) {
      if (removeRe.test(file)) {
        fs.unlinkSync(path.join(dir, file));
      }
    });
  }

  // Write the fragments to files.
  var files = 0;
  var realFilenames = [];

  function storeScript(script) {
    var fileIdx = files++;
    var content = '';

    realFilenames.push(script[0]);

    for (var i = 1, len = script.length; i < len; i++) {
      if (typeof script[i] === 'string') {
        content += script[i];
      } else {
        content += '\n#include "' + storeScript(script[i]) + '"\n';
      }
    }

    fs.writeFileSync(path.join(dir, fileIdx + '.inc'), content);

    return fileIdx;
  }

  storeScript(script);

  // TODO: Replace x.inc with the respective entry in realFilenames

  // Do the final compiling
  pawnc.invokeCompiler(path.join(dir, '0.inc'), {
    debugLevel: 2,
    tabsize: 4,
    requireSemicolons: true,
    requireParentheses: true,
    includeDirectory: 'include',
    outputFile: inputFile.replace(/\.[^\.]+$/, '.amx')
  }, function(err, result) {
    if (err) throw err;

    // Output errors, if any
    result.errors.forEach(function(error) {
      console.log(error.toString());
    });
  });
}

// Try finding existing files with the normal PAWNC extensions
// Returns null if none found
function _tryIncludeExtensions(p) {
  var ext = path.extname(p);

  if (ext && _isFile(p)) {
    return p;
  }

  p = p.replace(/\.(pwn|inc|p)$/, '');

  if (_isFile(p + '.inc')) return p + '.inc';
  if (_isFile(p + '.p')) return p + '.p';
  if (_isFile(p + '.pwn')) return p + '.pwn';

  return null;
}

// I hope this is self-explanatory
function _isFile(p) {
  if (!fs.existsSync(p)) {
    return false;
  }

  var stats = false;

  try {
    stats = fs.statSync(p);
  } catch (e) {}

  return (stats && stats.isFile());
}

// Normalize slashes, ".", and ".."
function _normalizePath(p) {
  p = p.replace(/[\/\\]/g, path.sep);
  p = p.replace(/[\/\\]+$/, '');
  p = path.resolve(p);

  return p;
}

// Make a valid Pawn symbol from a given path. Backslashes are treated
// different from slashes as per the Pawn compiler.
function _pawncFileSymbol(p) {
  var idx = p.lastIndexOf(PAWNC_DIRSEP);

  if (idx === -1) {
    throw new Error('Invalid last index: ' + p);
  }

  p = p.substr(idx + 1);
  p = p.replace(/\.[^\.\/\\]+$/, '');
  p = p.replace(/[^0-9a-z_@]/i, '_');

  return p;
}

// Recursively scan all included files, modify the #include directives, and store
// the modified code in a large tree-like structure.
function _buildIncludeTree(startFile, includePath) {
  var fileIdx = 0;
  var traversed = {};
  var allFiles = [];

  startFile = _normalizePath(startFile);
  includePath = _normalizePath(includePath);

  var startObj = {
    index: fileIdx++,
    realFile: startFile
  };

  allFiles.push(startObj);
  traversed[startFile] = startObj;

  // Add a backslash before the start file (see below why).
  startFile = path.dirname(startFile) + PAWNC_DIRSEP + path.basename(startFile);
  startObj.basename = _pawncFileSymbol(startFile);

  function traverse(file) {
    var code = fs.readFileSync(_normalizePath(file), 'ascii');

    var files = [];

    // Find the parent directory only by backslashes, as per the Pawn compiler.
    var idx = file.lastIndexOf(PAWNC_DIRSEP);

    if (idx === -1) {
      throw new Error('Unable to determine directory of "' + file + '"');
    }

    var fileDir = file.substr(0, idx);

    // Search for all #include directives and modify them.
    code = code.replace(/(^\s*#(try)?include)\s*(([<"])?\s*(\s*[^<"\s].+?[^>"\s]\s*|[^\s"<>]+)\s*[>"]|[^\s"<>]+)\s*?$/mg, function() {
      var match = arguments;
      var includeStr = match[5] || match[3];
      var checkDir = (match[4] === '"');
      var tryInclude = (match[2] === 'try');
      var includeFile;
      var includeObj;

      // The raw path is needed to maintain the backslashes/slashes as they
      // are treated differently by the compiler.
      var rawIncludeFile;

      // First check in the file's directory (if included with quotes)
      if (checkDir) {
        rawIncludeFile = fileDir + PAWNC_DIRSEP + includeStr;
        includeFile = _tryIncludeExtensions(_normalizePath(rawIncludeFile));
      }

      // Look in the include directory unless a file was found above
      if (!includeFile) {
        rawIncludeFile = includePath + PAWNC_DIRSEP + includeStr;
        includeFile = _tryIncludeExtensions(_normalizePath(rawIncludeFile));
      }

      // Still nothing found? Don't throw an error - only do that if the compiler
      // processes the line attempting to perform the include.
      if (!includeFile) {
        // Replace failing #tryinclude directives with mere comments
        if (tryInclude) {
          return '// Not found: #tryinclude ' + match[3];
        }

        // Throw errors if trying to include non-existing files
        return '#error Not found: #include ' + match[3];
      }

      rawIncludeFile += path.extname(includeFile);

      // Already loaded the file?
      if (traversed[includeFile]) {
        includeObj = traversed[includeFile];
      } else {
        includeObj = {
          // Unique index for this file
          index: fileIdx++,

          // Never forget your roots!
          realFile: includeFile,

          // What the file should be saved as by _saveIncludeTree.
          basename: _pawncFileSymbol(rawIncludeFile),

          // The file's code (with modified #include directives)
          code: null,

          // The files included by this file
          // http://i.imgur.com/unvL8Ev.jpg
          files: null
        };

        // It's important we do this before traversing into the file
        allFiles.push(includeObj);
        traversed[includeFile] = includeObj;

        var info = traverse(rawIncludeFile);

        includeObj.code = info.code;
        includeObj.files = info.files;
      }

      files.push(includeObj);

      // Return a modified #include directive
      // match[1] is #include or #tryinclude
      return match[1] + ' "' + includeObj.index  + PAWNC_DIRSEP + includeObj.basename + '"';
    });

    return {
      code: code,
      files: files
    };
  }

  var info = traverse(startFile, 0);

  startObj.code = info.code;
  startObj.files = info.files;
  startObj.allFiles = allFiles;

  return startObj;
}

// Save the tree to a flat file structure. Each file will have its
// own separate directory based on its unique index. The names are
// the ones made by _pawncFileSymbol.
function _saveIncludeTree(dir, tree) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }

  tree.allFiles.forEach(function(file) {
    var fileDir = path.join(dir, '' + file.index);

    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir);
    }

    fs.writeFileSync(path.join(fileDir, file.basename + '.inc'), file.code, 'ascii');
  });

  // Return the entry file
  return path.join(dir, '' + tree.allFiles[0].index, tree.allFiles[0].basename + '.inc');
}