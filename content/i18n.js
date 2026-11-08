window.yga = window.yga || {};

(function (yga) {
  "use strict";

  yga.i18n = function (key) {
    try {
      return chrome.i18n.getMessage(key) || key;
    } catch (e) {
      return key;
    }
  };
})(window.yga);
