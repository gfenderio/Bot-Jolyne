$h = @{ "Authorization" = "Bearer kyou-machitan-secret-2026"; "Content-Type" = "application/json" }
$u = "https://bot.kyou.id/machitan/ws-inbox"

$data = @(
  # Omega — Rini, opname pagi
  '{"actor":"Rini Astuti","items":[{"itemId":"10234","productName":"Tumbler Merah Premium 500ml","qtySent":50,"expectedQty":50,"actualQty":48,"selisih":-2,"source":"Omega","rack":"A-12"},{"itemId":"10235","productName":"Tumbler Biru Navy 500ml","qtySent":30,"expectedQty":30,"actualQty":30,"selisih":0,"source":"Omega","rack":"A-13"},{"itemId":"10240","productName":"Tumbler Hijau Army 600ml","qtySent":20,"expectedQty":20,"actualQty":23,"selisih":3,"source":"Omega","rack":"A-14"}]}',
  # SS — Budi, partial (rak bawah belum kelar)
  '{"actor":"Budi Santoso","isPartial":true,"items":[{"itemId":"10891","productName":"Tas Kain Motif Batik Size L","qtySent":28,"expectedQty":30,"actualQty":35,"selisih":5,"source":"SS","rack":"B-04"},{"itemId":"10892","productName":"Tas Kain Motif Batik Size M","qtySent":40,"expectedQty":40,"actualQty":38,"selisih":-2,"source":"SS","rack":"B-04"}]}',
  # Delta — Eka, opname siang
  '{"actor":"Eka Purnama","items":[{"itemId":"20011","productName":"Snack Box Coklat Wafer 12pcs","qtySent":100,"expectedQty":100,"actualQty":100,"selisih":0,"source":"Delta","rack":"C-01"},{"itemId":"20012","productName":"Snack Box Vanilla Wafer 12pcs","qtySent":80,"expectedQty":80,"actualQty":74,"selisih":-6,"source":"Delta","rack":"C-02"},{"itemId":"20013","productName":"Snack Box Stroberi Wafer 12pcs","qtySent":55,"expectedQty":60,"actualQty":67,"selisih":7,"source":"Delta","rack":"C-03"}]}',
  # Omega — Rini lagi, sesi kedua sore
  '{"actor":"Rini Astuti","items":[{"itemId":"10500","productName":"Botol Minum Anak Karakter Doraemon","qtySent":25,"expectedQty":25,"actualQty":25,"selisih":0,"source":"Omega","rack":"A-20"},{"itemId":"10501","productName":"Botol Minum Anak Karakter Hello Kitty","qtySent":15,"expectedQty":15,"actualQty":12,"selisih":-3,"source":"Omega","rack":"A-21"}]}',
  # SS — Budi, lanjutan partial tadi
  '{"actor":"Budi Santoso","items":[{"itemId":"10893","productName":"Tas Kain Polos Canvas Size XL","qtySent":18,"expectedQty":20,"actualQty":19,"selisih":-1,"source":"SS","rack":"B-05"}]}',
  # Delta — Sistem sheet sync
  '{"actor":"Sistem (Sinkronisasi Sheet)","isPartial":true,"items":[{"itemId":"20050","productName":"Coklat Batang Import Swiss 100g","qtySent":60,"expectedQty":60,"actualQty":60,"selisih":0,"source":"Delta","rack":""}]}'
)

foreach ($body in $data) {
  $r = Invoke-RestMethod -Uri $u -Method Post -Headers $h -Body $body -ErrorAction Stop
  Write-Host "OK: $($r.message)"
}

Write-Host "`nSemua data masuk. Trigger report..."
$r2 = Invoke-RestMethod -Uri "https://bot.kyou.id/machitan/ws-report-now" -Method Post -Headers $h -ErrorAction Stop
Write-Host "Report: $($r2.message)"
