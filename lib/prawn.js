'use strict';

var path = require('path');
var fs = require('fs');
var temp = require('temp');
var amx = require('./amx');
var pawnc = require('./pawnc');

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

// Compile LST file
if (fs.existsSync('test.lst')) {
  fs.unlinkSync('test.lst');
}

pawnc.invokeCompiler(inputFile, {
  includeDirectory: 'include',
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
  // Skip the first compiler directives
  script = script.substr(script.indexOf('#file'));
  
  // Remove any #endinput directives
  script = script.replace(/^\s*#endinput\s*?$/gm, '');
  
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

function _parseScript(script) {
  
  
  return script;
}