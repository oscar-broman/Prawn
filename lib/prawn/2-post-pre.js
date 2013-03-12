'use strict';

var fs = require('fs');
var path = require('path');
var temp = require('temp');
var rimraf = require('rimraf');
var pawnc = require('../pawnc');


exports.process = function(info, fn) {
  var dir;

  try {
    var dir = temp.mkdirSync('prawn');

    // Remove #file and #endinput directives
    info.ppScript = info.ppScript.replace(/^#(file|endinput).*?$/gm, '');

    // Build a tree from the flat lst-file
    info.fileTree = _buildFileTree(info.ppScript, 0, info.ppScript.indexOf('START_OF_@0();') + 14);

    // Save that tree in a folder. postFileIndexes will help keeping track
    // of the original filenames
    info.postFileIndexes = _saveFileTree(info.fileTree, dir, info.encoding);
  } catch (e) {
    if (dir) {
      try {
        rimraf.rimrafSync(dir);
      } catch (e) {}
    }

    return fn(e);
  }

  pawnc.invokeCompiler('0.inc', {
    includeDirectory: info.includePath,
    workingDirectory: dir,
    debugLevel: 2,
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
        var match = error.file.match(/(\d+)\.inc/);

        if (match) {
          var index = +match[1];

          index = info.postFileIndexes[index];

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

    // Yay!
    info.outputFile = result.outputFile;

    fn(null);
  });
};

// Make a tree structure from the flat lst-file
function _buildFileTree(code, fileIdx, offset) {
  var match, re = /^(START|END)_OF_@(\d+)\(\);$/gm;
  var fragments = [];
  var end = -1;
  var prevIndex;

  offset = offset || 0;
  prevIndex = offset;
  re.lastIndex = offset;

  while ((match = re.exec(code))) {
    var start = (match[1] === 'START');
    var index = +match[2];

    if (start) {
      fragments.push(code.substr(prevIndex, match.index - prevIndex));

      var file = _buildFileTree(code, index, match.index + match[0].length);

      fragments.push(file);

      re.lastIndex = prevIndex = file.end;
    } else {
      if (index !== fileIdx) {
        throw new Error('Found the wrong end for ' + fileIdx + ' (' + index + ')');
      }

      end = match.index + match[0].length;

      fragments.push(code.substr(prevIndex, match.index - prevIndex));

      break;
    }
  }

  if (end === -1) {
    throw new Error('Unable to find the end of ' + fileIdx + ' (' + offset + ')');
  }

  return {
    fileIdx: fileIdx,
    end: end,
    fragments: fragments
  };
}

// Save the tree to a folder
function _saveFileTree(tree, dir, encoding) {
  var fileCount = 0;
  var fileIndexes = [];

  function saveFile(file) {
    var fragments = file.fragments;
    var code = '';
    var idx = fileCount++;

    fileIndexes.push(file.fileIdx);

    for (var i = 0, len = fragments.length; i < len; i++) {
      var fragment = fragments[i];

      if (typeof fragment === 'string') {
        code += fragment;
      } else {
        var includedIdx = saveFile(fragment);

        code += '\n#include "' + includedIdx + '"\n';
      }
    }

    fs.writeFileSync(path.join(dir, idx + '.inc'), code, encoding);

    return idx;
  }

  saveFile(tree);

  return fileIndexes;
}