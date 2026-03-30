/**
 * OPTIONAL split deployment only.
 * Default: paste `Web order submission.gs` alone — it already includes doGet/doPost at the bottom.
 * Use this file only if you removed the bottom doGet/doPost block from that file (e.g. for hub merge).
 * Never add this to the hub project alongside Code.gs.
 */
function doGet() {
  return wos_webOrderDoGet_();
}

function doPost(e) {
  return wos_webOrderDoPost_(e);
}
