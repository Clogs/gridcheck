"use strict";

// Some slash commands report success when they refused. Which ones, and so
// what equivalent code looks like, is still to be surveyed: until then only
// the patch's marker shows it.

module.exports = {
  id: "slash-success",
  version: 1,
  title: "Refused slash commands report failure",
  files: [],
  detect: null,
};
