# Runs a fixed list of EC search samples back-to-back against the local EC service,
# one at a time (the automation browser only supports one run at a time on the
# shared persistent Chrome profile). For each sample it submits the request, then
# polls until it reaches a terminal status (completed/partial/failed), writing the
# current CAPTCHA image (if any) to captcha-current.png each time one appears so an
# operator can read it and answer via the console UI (http://localhost:8080/public/console.html).
# Progress and a final summary are written to sample-run-log.txt in this directory.

$ErrorActionPreference = "Stop"
$base = "http://localhost:8080"
$headers = @{ Authorization = "Bearer dev-tenant-key"; "Content-Type" = "application/json" }
$logPath = Join-Path $PSScriptRoot "sample-run-log.txt"
$captchaImgPath = Join-Path $PSScriptRoot "captcha-current.png"

function Log($msg) {
    $line = "$(Get-Date -Format 'HH:mm:ss') $msg"
    Write-Output $line
    Add-Content -Path $logPath -Value $line
}

$samples = @(
    @{ zone = "Chennai"; district = "Chennai Central"; sroCode = "Mylapore"; village = "Mylapore"; surveyNumber = "7"; ref = "s1-mylapore-sv7" }
    @{ zone = "Vellore"; district = "Cheyyar"; sroCode = "Arani_Cheyyar"; village = "Adaiyapulam"; surveyNumber = "5"; ref = "s2-cheyyar" }
    @{ zone = "Trichy"; district = "Ariyalur"; sroCode = "Aandimadam"; village = "Aiyur"; surveyNumber = "4"; ref = "s3-ariyalur" }
    @{ zone = "Madurai"; district = "Dindugul"; sroCode = "Aathur_Dindugal"; village = "Aadalur"; surveyNumber = "3"; ref = "s4-dindugul" }
    @{ zone = "Coimbatore"; district = "Coimbatore North"; sroCode = "Annur"; village = "Allappalayam"; surveyNumber = "2"; ref = "s5-coimbatore" }
    @{ zone = "Chennai"; district = "Chennai Central"; sroCode = "Mylapore"; village = "Mylapore"; surveyNumber = "1"; ref = "s6-mylapore-sv1" }
    @{ zone = "Vellore"; district = "Cheyyar"; sroCode = "Arani_Cheyyar"; village = "Adaiyapulam"; surveyNumber = "9"; ref = "s7-cheyyar-sv9" }
    @{ zone = "Trichy"; district = "Ariyalur"; sroCode = "Aandimadam"; village = "Aiyur"; surveyNumber = "8"; ref = "s8-ariyalur-sv8" }
)

$results = @()
$i = 0
foreach ($s in $samples) {
    $i++
    Log "=== Sample $i/$($samples.Count): $($s.district)/$($s.sroCode)/$($s.village) survey $($s.surveyNumber) ==="

    $body = @{
        searchType = "EC_WISE"
        certified = $false
        property = @{
            zone = $s.zone; district = $s.district; sroCode = $s.sroCode
            village = $s.village; surveyNumber = $s.surveyNumber
        }
        period = @{ from = "2004-01-01"; to = "2024-12-31" }
        callbackUrl = "https://example.com/webhook"
        reference = "$($s.ref)-$(Get-Date -Format HHmmss)"
    } | ConvertTo-Json -Depth 5

    $submitHeaders = $headers.Clone()
    $submitHeaders["Idempotency-Key"] = [guid]::NewGuid().ToString()

    try {
        $resp = Invoke-RestMethod -Uri "$base/v1/ec-requests" -Method Post -Headers $submitHeaders -Body $body
    } catch {
        Log "SUBMIT FAILED: $_"
        $results += [pscustomobject]@{ sample = $i; ref = $s.ref; status = "submit_failed"; detail = "$_" }
        continue
    }
    $requestId = $resp.requestId
    Log "submitted requestId=$requestId"

    $deadline = (Get-Date).AddMinutes(10)
    $lastTaskId = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $status = Invoke-RestMethod -Uri "$base/v1/ec-requests/$requestId" -Headers $headers -Method Get

        if ($status.status -in @("completed", "partial", "failed")) {
            $pdfRef = $null
            if ($status.result -and $status.result.provenance -and $status.result.provenance.rawArtifactRefs) {
                $pdfRef = $status.result.provenance.rawArtifactRefs | Where-Object { $_ -like "file://*.pdf" } | Select-Object -First 1
            }
            Log "FINISHED status=$($status.status) pdf=$pdfRef failure=$($status.failure.message)"
            $results += [pscustomobject]@{ sample = $i; ref = $s.ref; status = $status.status; pdf = $pdfRef; failure = $status.failure.message }
            break
        }

        $tasks = Invoke-RestMethod -Uri "$base/ops/tasks?status=open" -Method Get
        if ($tasks.tasks.Count -gt 0) {
            $task = $tasks.tasks[0]
            if ($task.id -ne $lastTaskId) {
                $lastTaskId = $task.id
                $b64 = $task.context.imageBase64 -replace '^data:image/png;base64,', ''
                [System.IO.File]::WriteAllBytes($captchaImgPath, [Convert]::FromBase64String($b64))
                Log "CAPTCHA ready -> $captchaImgPath (task $($task.id)) - solve it at $base/public/console.html"
            }
        }
    }
    if ((Get-Date) -ge $deadline) {
        Log "TIMED OUT waiting for sample $i"
        $results += [pscustomobject]@{ sample = $i; ref = $s.ref; status = "timed_out" }
    }
}

Log "=== SUMMARY ==="
$results | ForEach-Object { Log ("sample {0} ({1}): {2} {3}" -f $_.sample, $_.ref, $_.status, $_.pdf) }
