/**
 * Kirim tiap pengajuan Form Peminjaman Costume ke Bot-Jolyne, yang lalu
 * memposting embed-nya ke Discord. Dipasang di spreadsheet tanggapan.
 *
 * Token diambil dari Script Properties (COSTUME_LOAN_TOKEN), sengaja tidak
 * ditulis di sini supaya tidak ikut terbaca editor spreadsheet.
 * Jalankan pasangPemicu() sekali untuk memasang pemicu on form submit.
 */

var BOT_URL = "http://w9a2iwiolpi9wvw2fx6wlboo.43.134.34.13.sslip.io/forms/costume-loan";

/** Aman dijalankan berulang: pemicu lama dibuang dulu. */
function pasangPemicu() {
  var pemicuLama = ScriptApp.getProjectTriggers();
  for (var i = 0; i < pemicuLama.length; i++) {
    if (pemicuLama[i].getHandlerFunction() === "kirimKeDiscord") {
      ScriptApp.deleteTrigger(pemicuLama[i]);
    }
  }
  ScriptApp.newTrigger("kirimKeDiscord")
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onFormSubmit()
    .create();
}

/**
 * e.namedValues = { "judul pertanyaan": ["jawaban"] } — dibaca dari JUDUL kolom,
 * bukan nomor kolom, supaya penambahan kolom di tengah tidak menggeser apa pun.
 */
function kirimKeDiscord(e) {
  var token = PropertiesService.getScriptProperties().getProperty("COSTUME_LOAN_TOKEN");
  if (!token) {
    Logger.log("COSTUME_LOAN_TOKEN belum diisi di Script Properties, kiriman dilewati.");
    return;
  }

  var jawaban = [];
  var namedValues = (e && e.namedValues) || {};
  for (var pertanyaan in namedValues) {
    if (!Object.prototype.hasOwnProperty.call(namedValues, pertanyaan)) continue;
    var isi = namedValues[pertanyaan];
    jawaban.push({
      question: String(pertanyaan),
      answer: Array.isArray(isi) ? isi.join(", ") : String(isi)
    });
  }

  if (jawaban.length === 0) {
    Logger.log("Kiriman tanpa jawaban, dilewati.");
    return;
  }

  // Penanda kiriman: dipakai bot supaya percobaan ulang di bawah tidak
  // memposting embed dua kali.
  var responseId = (e && e.range) ? "row-" + e.range.getRow() : String(new Date().getTime());

  var opsi = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ responseId: responseId, answers: jawaban }),
    muteHttpExceptions: true
  };

  // Coba dua kali: bot kadang sedang redeploy dan koneksinya ditolak sesaat.
  for (var percobaan = 1; percobaan <= 2; percobaan++) {
    try {
      var res = UrlFetchApp.fetch(BOT_URL, opsi);
      var kode = res.getResponseCode();
      if (kode >= 200 && kode < 300) {
        Logger.log("Terkirim ke Discord (" + responseId + ").");
        return;
      }
      Logger.log("Bot menjawab " + kode + ": " + res.getContentText());
    } catch (err) {
      Logger.log("Percobaan " + percobaan + " gagal: " + err);
    }
    if (percobaan === 1) Utilities.sleep(3000);
  }

  Logger.log("Gagal mengirim ke Discord setelah 2 percobaan (" + responseId + ").");
}
