/**
 * Dedicated login Web App.
 *
 * Deploy this file's project as a separate Web App URL for login/session endpoints:
 * - GET  ?action=health
 * - GET  ?action=sessionPing&sessionToken=...
 * - GET  ?action=loginPage
 * - POST { action: "login", username, password }
 *
 * API side:
 * - Set GOOGLE_SHEET_LOGIN_APPS_SCRIPT_URL to this deployment URL.
 * - Keep GOOGLE_SHEET_APPS_SCRIPT_URL for the main controller app.
 */

var LWA_TAB_WEB_LOGIN = "WebLogin";
var LWA_WEB_SESSION_CACHE_PREFIX = "jrws:";
var LWA_WEB_SESSION_TTL_SEC = 21600;
var LWA_SHEET_ID_PROP = "WEBLOGIN_SPREADSHEET_ID";

function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || "health").trim();
  if (action === "health") return LWA_json_({ ok: true, service: "jr-login-web-app" });
  if (action === "sessionPing") {
    var tok = String((e && e.parameter && e.parameter.sessionToken) || "").trim();
    return LWA_json_({ ok: true, valid: LWA_webSessionIsValid_(tok) });
  }
  if (action === "loginPage") return LWA_htmlLoginPageOutput_();
  return LWA_json_({ ok: false, error: "Unknown action: " + action }, 400);
}

function doPost(e) {
  var payload = LWA_parsePostPayload_(e);
  var action = String(payload.action || "").trim();
  if (action === "login") return LWA_handleWebLoginPayload_(payload);
  return LWA_json_({ ok: false, error: "Unknown action: " + action }, 400);
}

function LWA_parsePostPayload_(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    var raw = String(e.postData.contents).trim();
    if (raw.length) {
      if (raw.charAt(0) === "{") {
        try {
          return JSON.parse(raw);
        } catch (err) {
          throw new Error("Invalid JSON body: " + err);
        }
      }
      if (raw.indexOf("=") >= 0) {
        var o = {};
        raw.split("&").forEach(function (pair) {
          var i = pair.indexOf("=");
          var k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, " ");
          var v = decodeURIComponent(i < 0 ? "" : pair.slice(i + 1)).replace(/\+/g, " ");
          if (k) o[k] = v;
        });
        return o;
      }
    }
  }
  var p = e.parameter || {};
  var out = {};
  Object.keys(p).forEach(function (k) {
    out[k] = p[k];
  });
  return out;
}

function LWA_webSessionIsValid_(token) {
  if (!token) return false;
  var u = CacheService.getScriptCache().get(LWA_WEB_SESSION_CACHE_PREFIX + token);
  return u != null && String(u).length > 0;
}

function LWA_webSessionCreate_(username) {
  var raw = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  CacheService.getScriptCache().put(LWA_WEB_SESSION_CACHE_PREFIX + raw, String(username), LWA_WEB_SESSION_TTL_SEC);
  return raw;
}

function LWA_getSpreadsheet_() {
  var id = String(PropertiesService.getScriptProperties().getProperty(LWA_SHEET_ID_PROP) || "").trim();
  if (id) {
    return SpreadsheetApp.openById(id);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function LWA_ensureWebLoginTab_() {
  var ss = LWA_getSpreadsheet_();
  var sh = ss.getSheetByName(LWA_TAB_WEB_LOGIN);
  if (!sh) sh = ss.insertSheet(LWA_TAB_WEB_LOGIN);
  if (sh.getLastRow() < 1) sh.getRange(1, 1, 1, 2).setValues([["username", "password"]]);
}

function LWA_webLoginSheetValuesAB_() {
  var sh = LWA_getSpreadsheet_().getSheetByName(LWA_TAB_WEB_LOGIN);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 2).getValues();
}

function LWA_webLoginSheetMatches_(username, password) {
  var values = LWA_webLoginSheetValuesAB_();
  var uIn = String(username || "").trim();
  var pIn = String(password != null ? password : "").trim();
  for (var i = 0; i < values.length; i++) {
    var u = String(values[i][0] != null ? values[i][0] : "").trim();
    var p = String(values[i][1] != null ? values[i][1] : "").trim();
    if (u === uIn && p === pIn) return true;
  }
  return false;
}

function LWA_hasWebLoginRows_() {
  var values = LWA_webLoginSheetValuesAB_();
  for (var i = 0; i < values.length; i++) {
    var u = String(values[i][0] != null ? values[i][0] : "").trim();
    var p = String(values[i][1] != null ? values[i][1] : "").trim();
    if (u && p) return true;
  }
  return false;
}

function LWA_handleWebLoginPayload_(payload) {
  LWA_ensureWebLoginTab_();
  var u = String((payload && (payload.username || payload.user || payload.email)) || "").trim();
  var p = String((payload && payload.password) != null ? payload.password : "");
  if (!LWA_hasWebLoginRows_()) {
    return LWA_json_({
      ok: false,
      error: "WebLogin tab is empty. Add row 2+ with A=username and B=password."
    });
  }
  if (LWA_webLoginSheetMatches_(u, p)) {
    return LWA_json_({
      ok: true,
      sessionToken: LWA_webSessionCreate_(u),
      expiresInSeconds: LWA_WEB_SESSION_TTL_SEC
    });
  }
  Utilities.sleep(300 + Math.floor(Math.random() * 200));
  return LWA_json_({ ok: false, error: "Invalid username or password." });
}

function LWA_htmlLoginPageOutput_() {
  var svcUrl = "";
  try {
    svcUrl = ScriptApp.getService().getUrl();
  } catch (err) {
    svcUrl = "";
  }
  var esc = JSON.stringify(svcUrl || "");
  var html =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">" +
    "<title>JR Hub login</title>" +
    "<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:2rem auto;padding:0 14px;color:#222}" +
    "h1{font-size:1.25rem}label{display:block;margin:.65rem 0 .2rem;font-size:13px}" +
    "input{width:100%;padding:.55rem;box-sizing:border-box;font-size:15px;border:1px solid #ccc;border-radius:6px}" +
    "button{margin-top:1rem;padding:.6rem 1rem;cursor:pointer;border-radius:6px;border:1px solid #333;background:#111;color:#fff;font-size:14px}" +
    "#out{margin-top:1rem;white-space:pre-wrap;font-size:12px;background:#f6f6f6;padding:10px;border-radius:6px;word-break:break-all}" +
    ".hint{color:#666;font-size:13px;margin-top:.5rem}</style></head><body>" +
    "<h1>JR Hub Login</h1>" +
    "<p class=\"hint\">Sign in.</p>" +
    "<form id=\"f\">" +
    "<label>Username</label><input name=\"username\" autocomplete=\"username\" required>" +
    "<label>Password</label><input name=\"password\" type=\"password\" autocomplete=\"current-password\" required>" +
    "<button type=\"submit\">Sign in</button></form>" +
    "<div id=\"out\"></div>" +
    "<script>(function(){var deployed=" +
    esc +
    ";function base(){if(deployed)return deployed;var h=location.href.split(\"?\")[0];return h;}" +
    "document.getElementById(\"f\").addEventListener(\"submit\",function(ev){ev.preventDefault();" +
    "var fd=new FormData(ev.target);var o={action:\"login\",username:fd.get(\"username\"),password:fd.get(\"password\")};" +
    "fetch(base(),{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify(o)})" +
    ".then(function(r){return r.json()})" +
    ".then(function(j){document.getElementById(\"out\").textContent=JSON.stringify(j,null,2);})" +
    ".catch(function(e){document.getElementById(\"out\").textContent=String(e);});});})();</script>" +
    "</body></html>";
  return HtmlService.createHtmlOutput(html).setTitle("JR Hub login").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function LWA_json_(obj, code) {
  var out = ContentService.createTextOutput(JSON.stringify(obj || {}));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}
