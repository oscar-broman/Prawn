'use strict';

var path = require('path');
var fs = require('fs');
var pawnc = require('../pawnc');
var temp = require('temp');
var rimraf = require('rimraf');


var PAWN_DIRSEP = '\\';
var PAWN_SYMBOL = /^[a-z_@][a-z0-9_@]*$/i;


// Entry point for this module
exports.process = function(info, fn) {
  var dir;

  try {
    dir = temp.mkdirSync('prawn');
    _process(info, dir);
  } catch (e) {
    if (dir) {
      try {
        rimraf.rimrafSync(dir);
      } catch (e) {}
    }

    fn(e);

    return;
  }

  info.prePreDir = dir;

  pawnc.invokeCompiler(path.resolve(info.entryFile), {
    includeDirectory: info.includePath,
    workingDirectory: dir,
    debugLevel: 2,
    outputLst: true,
    requireSemicolons: true,
    requireParentheses: true,

    PRAWN: true
  }, function(err, result) {
    try {
      rimraf.rimrafSync(dir);
    } catch (e) {}

    var errCount = 0;

    // Put the correct filenames in any error messages
    if (result.errors) {
      result.errors.forEach(function(error) {
        var match = error.file.match(/\b(\d+)[\/\\][^\/\\]+\.inc$/);

        if (match) {
          var index = +match[1];

          error.file = info.prePreTree.allFiles[index].realFile;
        }

        if (error.type !== 'warning') {
          errCount++;
        }
      });

      info.errors = info.errors.concat(result.errors);
    }

    // Halt on errors invoking the compiler
    if (err) {
      return fn(err);
    }

    // Halt on any errors except warnings
    if (errCount) {
      if (result.outputFile && fs.existsSync(result.outputFile)) {
        fs.unlinkSync(result.outputFile);
      }

      return fn(new Error('The compiler failed with errors.'));
    }

    // Got this far without an output file?
    if (!result.outputFile || !fs.existsSync(result.outputFile)) {
      return fn(new Error('The compiler failed without errors.'));
    }

    // Store the preprocessed script
    info.ppScript = fs.readFileSync(result.outputFile, info.encoding);

    if (result.outputFile && fs.existsSync(result.outputFile)) {
      fs.unlinkSync(result.outputFile);
    }

    fn(null);
  });
};

function _process(info, dir) {
  var includeTree = _buildIncludeTree(info.inputFile, info.includePath, info);

  info.prePreTree = includeTree;
  info.entryFile = _saveIncludeTree(dir, includeTree, info);
}

// Recursively scan all included files, modify the #include directives, and store
// the modified code in a large tree structure.
function _buildIncludeTree(startFile, includePath, info) {
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
  startFile = path.dirname(startFile) + PAWN_DIRSEP + path.basename(startFile);
  startObj.basename = _pawnFileSymbol(startFile);

  function traverse(file) {
    var code = fs.readFileSync(_normalizePath(file), info.encoding);

    var files = [];

    // Find the parent directory only by backslashes, as per the Pawn compiler.
    var idx = file.lastIndexOf(PAWN_DIRSEP);

    if (idx === -1) {
      throw new Error('Unable to determine directory of "' + file + '"');
    }

    var fileDir = file.substr(0, idx);

    // Search for all #include directives and modify them.
    code = code.replace(/(^\s*#(try)?include)\s*(([<"])?\s*(\s*[^<"\s].+?[^>"\s]\s*|[^\s"<>]+)\s*[>"]|[^\s"<>]+)\s*?(\/[\/*].*?)?$/mg, function() {
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
        rawIncludeFile = fileDir + PAWN_DIRSEP + includeStr;
        includeFile = _tryIncludeExtensions(_normalizePath(rawIncludeFile));
      }

      // Look in the include directory unless a file was found above
      if (!includeFile) {
        rawIncludeFile = includePath + PAWN_DIRSEP + includeStr;
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
          basename: _pawnFileSymbol(rawIncludeFile),

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
      return match[1] + ' "' + includeObj.index  + PAWN_DIRSEP + includeObj.basename + '"';
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
// the ones made by _pawnFileSymbol.
function _saveIncludeTree(dir, includeTree, info) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }

  includeTree.allFiles.forEach(function(file) {
    var fileDir = path.join(dir, '' + file.index);

    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir);
    }

    // TODO: async
    info.extensions.forEach(function(extension) {
      if (extension.preParse) {
        file = extension.preParse(file) || file;
      }
    });

    file.code = 'START_OF_@' + file.index + '();\n#line 0\n' + file.code + '\nEND_OF_@' + file.index + '();\n';
    file.code = file.code.replace(/^\s*?#endinput/gm, function(match) {
      return 'END_OF_@' + file.index + '();\n#endinput';
    });
    fs.writeFileSync(path.join(fileDir, file.basename + '.inc'), file.code, info.encoding);
  });

  // Return the entry file
  return path.join(dir, '' + includeTree.allFiles[0].index, includeTree.allFiles[0].basename + '.inc');
}

// Try finding existing files with the normal Pawn extensions
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
function _pawnFileSymbol(p) {
  var idx = p.lastIndexOf(PAWN_DIRSEP);

  if (idx === -1) {
    throw new Error('Invalid last index: ' + p);
  }

  p = p.substr(idx + 1);
  p = p.replace(/\.[^\.\/\\]+$/, '');
  p = p.replace(/[^0-9a-z_@]/i, '_');

  return p;
}