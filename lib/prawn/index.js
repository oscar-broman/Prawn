'use strict';

var path = require('path');
var fs = require('fs');
var rimraf = require('rimraf');

// The three stages of compilation
//
// prePre
//   1. Find all included files
//   2. Put these files in a new directory
//   3. Allow extensions to make modifications to the files
//   4. Use the Pawn compiler to preprocess the files (-l)
//
// postPre
//   1. Split the lst-file back into separate files
//   2. Allow extensions to modify the files
//   3. Compile the files
//
// postCompile
//   1. Load the AMX into memory as a modifiable structure
//   2. Replace file paths to the right ones in the debug information
//   3. Allow extensions to modify the structure
//   4 Save the AMX
var prePre = require('./1-pre-pre');
var postPre = require('./2-post-pre');
var postCompile = require('./3-post-compile');

// Load extensions from "lib/prawn/ext"
function _requireExtensions() {
  var extensions = [];
  var extPath = path.join(__dirname, 'ext');

  fs.readdirSync(extPath).forEach(function(file) {
    extensions.push(require(path.join(extPath, file)));
  });

  extensions.sort(function(l, r) {
    return (r.priority || 0) - (l.priority || 0);
  });
  console.log(extensions)
  return extensions;
}

// Get the input file (1st argument)
function _getInputFile() {
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

  return inputFile;
}

// TODO: Add flag to show/hide trace
function _errorOccurred(err, msg) {
  console.error(msg);
  console.error('Error:', err.message);

  if (_info.errors) {
    _info.errors.forEach(function(error) {
      console.error('Compiler:', error.toString());
    });
  }

  if (true) {
    throw err;
  }
}

// Try cleaning up as much as possible
function _cleanup() {
  if (_info.prePreDir) {
    try {
      rimraf.rimrafSync(_info.prePreDir);
    } catch (e) {}
  }

  if (_info.outputFile) {
    try {
      fs.unlinkSync(_info.outputFile);
    } catch (e) {}
  }
}

// TODO: Support custom include directories
function _getIncludePath() {
  return path.resolve(__dirname, '..', '..', 'include');
}

// This will be passed between the compilation stages
var _info = {
  encoding: 'ascii',
  inputFile: _getInputFile(),
  includePath: _getIncludePath(),
  extensions: _requireExtensions(),
  errors: []
};

// Prepare for preprocessing
prePre.process(_info, function(err) {
  if (err) {
    _cleanup();
    return _errorOccurred(err, 'Failed while preparing to preprocess.');
  }

  postPre.process(_info, function(err) {
    if (err) {
      _cleanup();
      return _errorOccurred(err, 'Failed while processing the preprocessed file.');
    }

    postCompile.process(_info, function(err) {
      if (err) {
        _cleanup();
        return _errorOccurred(err, 'Failed while modifying the AMX.');
      }

      if (_info.errors) {
        _info.errors.forEach(function(error) {
          console.error('Compiler:', error.toString());
        });
      }
      
      var outputFile = _info.inputFile.replace(/\.(pwn|inc|p)$/i, '') + '.amx';
      
      fs.renameSync(_info.outputFile, outputFile);

      console.log('Compiled successfully!');
      console.log('Output file:', outputFile);
    });
  });
});
