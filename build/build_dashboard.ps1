<#
  FnGuide 당일 기업 리포트 대시보드 - 클라우드(GitHub Actions/Linux, PowerShell Core) 빌드
  - 자격증명은 환경변수(FN_USER_ID / FN_USER_PW = GitHub Secrets)에서 읽음
  - 당일 기업 리포트 전체 수집 + 액션태그 + 목표가추이 차트 -> index.html 생성 (Excel 없음)
#>
$ErrorActionPreference = 'Stop'
$UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
$Base = 'https://www.fnguide.com'
$IC   = [Globalization.CultureInfo]::InvariantCulture

$UserId = $env:FN_USER_ID
$UserPw = $env:FN_USER_PW
if ([string]::IsNullOrWhiteSpace($UserId) -or [string]::IsNullOrWhiteSpace($UserPw)) { throw "FN_USER_ID / FN_USER_PW 환경변수(Secrets)가 없습니다." }

# KST 기준 오늘
$kst = (Get-Date).ToUniversalTime().AddHours(9)
$Date      = $kst.ToString('yyyy-MM-dd')
$DateShort = $kst.ToString('yy.MM.dd')
$OutFile   = Join-Path (Get-Location) 'index.html'

$PubB64 = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtslz/3S9JOffjEpULeC93FZAUoS011Mve0Cb/4QD4/mr+KMbDMnbhYPlIfVQBvtz38t7/fessu7mjMt/t9aSNxLS+cpr496NO9T92YycRfl0VfBIoG5OrC6gMO5/fx7saMHsq8hnq4kOBa5YrT+6/pMhHSd3N8F8DFZwDLjRGhUmeTiAwvT5xM7I4jwC+G7LTxxlRXmuRzpqg6SPdasDERP81+rLnmG0SbK/3buemavAOoGrXUjURrgg47bH9J+kNjEzkxdDir/d1KLG3vbWQQXYMtwpbHl6DEd9kDrg4j00IDnUCIIcgPNAbEvHUOu49uGM5nVzguHc008Jt0eGiQIDAQAB'

function HtmlEnc([string]$s) { [System.Net.WebUtility]::HtmlEncode($s) }
function To-Num([string]$s) { if ([string]::IsNullOrWhiteSpace($s)) { return $null }; $t = ($s -replace '[^0-9-]',''); if ($t -eq '' -or $t -eq '-') { return $null }; [int64]$t }
function R1([double]$x) { ([math]::Round($x,1)).ToString($IC) }
function PrcLabel($t){ switch ("$t") { '1'{'목표가▲상향'} '2'{'목표가 유지'} '3'{'목표가▼하향'} '4'{'신규'} default{'-'} } }
function PrcCls($t){ switch ("$t") { '1'{'a-up'} '2'{'a-keep'} '3'{'a-dn'} '4'{'a-new'} default{'a-none'} } }
function RecLabel($t){ switch ("$t") { '1'{'의견▲상향'} '3'{'의견▼하향'} '4'{'의견 신규'} default{''} } }

# ---- 로그인 (RSA-OAEP-SHA256, .NET Core) ----
Write-Host "[1/4] 로그인..."
$der = [Convert]::FromBase64String($PubB64)
$rsa = [System.Security.Cryptography.RSA]::Create()
$read = 0; $rsa.ImportSubjectPublicKeyInfo($der, [ref]$read)
$encPw = [Convert]::ToBase64String($rsa.Encrypt([Text.Encoding]::UTF8.GetBytes($UserPw), [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256))
$null = Invoke-WebRequest -Uri "$Base/Users/Login" -SessionVariable s -UserAgent $UA -TimeoutSec 30
$hd = @{ 'X-Requested-With'='XMLHttpRequest'; 'Referer'="$Base/Users/Login"; 'Origin'=$Base }
function Login([string]$lt){ (Invoke-WebRequest -Uri "$Base/Users/UserLogin" -Method Post -Body @{loginType=$lt;userId=$UserId;userPassword=$encPw} -Headers $hd -WebSession $s -UserAgent $UA -TimeoutSec 30).Content | ConvertFrom-Json }
$r = Login '1'
if ($r.returnCode -in '80115','80116') { $r = Login '2' }
if ($r.returnCode -ne '0') { throw "로그인 실패 returnCode=$($r.returnCode) msg=$($r.returnMessage)" }
Write-Host "  로그인 성공"

# ---- 당일 기업 리포트 수집 ----
Write-Host "[2/4] '$Date' 당일 기업 리포트 수집..."
$refSR = @{ 'Referer'="$Base/Research/SearchReport"; 'X-Requested-With'='XMLHttpRequest'; 'Origin'=$Base }
$rawAll = @(); $page = 1
do {
    $body = @{ srchTyp=0; srchKeyword=''; srchCode=''; cmpCd=''; menuCd=''; fromDt=$Date; toDt=$Date; curPage=$page; perPage=500; ordCol='ANL_DT'; ordDir='D'; useDb=$false }
    $j = (Invoke-WebRequest -Uri "$Base/Research/GetReports" -Method Post -Body $body -Headers $refSR -WebSession $s -UserAgent $UA -TimeoutSec 40).Content | ConvertFrom-Json
    $b = @(); if ($j.dataSet -and $j.dataSet.reports) { $b = @($j.dataSet.reports) }
    $rawAll += $b
    $more = ($b.Count -eq 500) -and ($b[-1].ANL_DT -eq $DateShort)
    $page++
} while ($more -and $page -le 5)
$corp = @($rawAll | Where-Object { $_.ANL_DT -eq $DateShort -and $_.CATEGORY.TYP -eq 1 -and $_.CATEGORY.VALUE })
Write-Host "  당일 기업 리포트: $($corp.Count)건"

# ---- 종목별 목표가 추이 ----
$fromYr = $kst.AddYears(-1).ToString('yyyy-MM-dd')
$tpCache = @{}
function Get-TpSeries([string]$code) {
    if ($tpCache.ContainsKey($code)) { return $tpCache[$code] }
    $series = @()
    try {
        $body = @{ srchTyp=1; srchKeyword=''; srchCode=$code; cmpCd=$code; fromDt=$fromYr; toDt=$Date; curPage=1; perPage=500; ordCol='ANL_DT'; ordDir='A'; useDb=$false }
        $j = (Invoke-WebRequest -Uri "$Base/Research/GetReports" -Method Post -Body $body -Headers $refSR -WebSession $s -UserAgent $UA -TimeoutSec 40).Content | ConvertFrom-Json
        if ($j.dataSet -and $j.dataSet.reports) {
            foreach ($it in $j.dataSet.reports) {
                $v = To-Num $it.TARGET_PRICE
                if ($v -and $v -gt 0) {
                    $d = $null; try { $d = [datetime]::ParseExact($it.ANL_DT,'yy.MM.dd',$IC) } catch {}
                    if ($d) { $series += [pscustomobject]@{ D=$d; V=$v; Brk=$it.BROKERAGE.NAME } }
                }
            }
        }
    } catch {}
    $series = @($series | Sort-Object D)
    $tpCache[$code] = $series
    return $series
}
function Get-PrevTp([string]$code, [string]$brk, [datetime]$before) {
    $ser = Get-TpSeries $code
    $prev = @($ser | Where-Object { $_.Brk -eq $brk -and $_.D -lt $before }) | Select-Object -Last 1
    if ($prev) { return $prev.V } else { return $null }
}
Write-Host "[3/4] 종목별 목표가 추이 수집..."
$codes = @($corp | ForEach-Object { $_.CATEGORY.VALUE } | Where-Object { $_ } | Select-Object -Unique)
foreach ($c in $codes) { [void](Get-TpSeries $c) }

# ---- 레코드 ----
$recs = foreach ($it in $corp) {
    $code = $it.CATEGORY.VALUE
    $rd = [datetime]::ParseExact($it.ANL_DT,'yy.MM.dd',$IC)
    $cur = To-Num $it.TARGET_PRICE
    $prc = "$($it.PRC_ACTION_TYP)"
    $pct = $null
    if ($prc -in '1','3' -and $cur) { $prev = Get-PrevTp $code $it.BROKERAGE.NAME $rd; if ($prev -and $prev -ne 0) { $pct = [math]::Round(($cur-$prev)/$prev*100,1) } }
    $rank = switch ($prc) { '1'{0} '4'{1} '3'{2} '2'{3} default{4} }
    [pscustomobject]@{
        Company=$it.CATEGORY.NAME; Code=$code; Brokerage=$it.BROKERAGE.NAME
        Analysts=($it.ANALYSTS.NAME -join ', '); Recomm=$it.RECOMM; Tp=$it.TARGET_PRICE; Pct=$pct
        Prc=$prc; Rec="$($it.RECOMM_ACTION_TYP)"; Flash=[bool]$it.FLASH_YN
        Title=$it.RPT_TITLE; Comment=@($it.COMMENT); Pages=$it.PAGE_CNT; RptId=$it.RPT_ID; Rank=$rank
    }
}
$recs = @($recs | Sort-Object Rank, @{Expression={ if ($_.Pct -eq $null){-999}else{$_.Pct} };Descending=$true}, Company)
$cAll=$recs.Count
$cUp=@($recs|?{$_.Prc -eq '1'}).Count; $cDn=@($recs|?{$_.Prc -eq '3'}).Count
$cNew=@($recs|?{$_.Prc -eq '4'}).Count; $cKeep=@($recs|?{$_.Prc -eq '2'}).Count
$cRec=@($recs|?{$_.Rec -in '1','3','4'}).Count

function New-Sparkline($series) {
    $n = $series.Count
    if ($n -eq 0) { return '<span class="nochart">-</span>' }
    $w=150; $h=42; $pl=5; $pr=44; $pt=7; $pb=7
    $vals=@($series|%{$_.V}); $min=($vals|Measure-Object -Min).Minimum; $max=($vals|Measure-Object -Max).Maximum
    $minD=$series[0].D; $maxD=$series[-1].D
    $spanD=($maxD-$minD).TotalDays; if($spanD -le 0){$spanD=1}
    $spanV=$max-$min; if($spanV -le 0){$spanV=1}
    $pts=@(); $tip=@()
    foreach($p in $series){ $x=$pl+($p.D-$minD).TotalDays/$spanD*($w-$pl-$pr); $y=$h-$pb-($p.V-$min)/$spanV*($h-$pt-$pb); $pts+=("{0},{1}" -f (R1 $x),(R1 $y)); $tip+=("{0} {1}" -f $p.D.ToString('yy.MM.dd'),$p.V.ToString('N0')) }
    $first=$series[0].V; $last=$series[-1].V
    $cls=if($last -gt $first){'sp-up'}elseif($last -lt $first){'sp-dn'}else{'sp-fl'}
    $lx=$pl+($maxD-$minD).TotalDays/$spanD*($w-$pl-$pr); $ly=$h-$pb-($last-$min)/$spanV*($h-$pt-$pb)
    $poly=if($n -ge 2){"<polyline class='$cls' points='$($pts -join ' ')' style='fill:none' stroke-width='1.6'/>"}else{''}
    $title=HtmlEnc ($tip -join " · ")
    return "<svg class='spark' viewBox='0 0 $w $h' width='$w' height='$h'><title>$title ($($n)건)</title>$poly<circle class='$cls' cx='$(R1 $lx)' cy='$(R1 $ly)' r='2.3'/><text class='spv' x='$($w-$pr+4)' y='$(R1 ($ly+3))'>$($last.ToString('N0'))</text></svg>"
}

Write-Host "[4/4] index.html 생성..."
$sb = New-Object System.Text.StringBuilder
foreach ($row in $recs) {
    $chart = New-Sparkline (Get-TpSeries $row.Code)
    $cmt = ($row.Comment | ForEach-Object { "<li>$(HtmlEnc $_)</li>" }) -join ''
    $link = "$Base/Research/SearchReport#$($row.RptId)"
    $prcLab = PrcLabel $row.Prc; $prcCls = PrcCls $row.Prc; $recLab = RecLabel $row.Rec
    $tag = "<span class='tag $prcCls'>$(HtmlEnc $prcLab)</span>"
    if ($recLab) { $tag += " <span class='tag a-rec'>$(HtmlEnc $recLab)</span>" }
    if ($row.Flash) { $tag += " <span class='tag a-flash'>속보</span>" }
    $pctTxt = if ($row.Pct -ne $null) { ("{0:+0.0;-0.0}%" -f $row.Pct) } else { '' }
    $pctCls = if ($row.Pct -ne $null -and $row.Pct -gt 0) { 'pup' } elseif ($row.Pct -ne $null -and $row.Pct -lt 0) { 'pdn' } else { '' }
    $tpTxt = if ($row.Tp) { HtmlEnc $row.Tp } else { '-' }
    [void]$sb.Append("<tr data-prc='$($row.Prc)' data-rec='$($row.Rec)'>")
    [void]$sb.Append("<td class='c-company'><b>$(HtmlEnc $row.Company)</b><span class='code'>$(HtmlEnc $row.Code)</span></td>")
    [void]$sb.Append("<td>$(HtmlEnc $row.Brokerage)</td><td class='c-an'>$(HtmlEnc $row.Analysts)</td>")
    [void]$sb.Append("<td>$(HtmlEnc $row.Recomm)</td>")
    [void]$sb.Append("<td class='r tp'>$tpTxt</td><td class='r $pctCls'>$pctTxt</td>")
    [void]$sb.Append("<td class='c-tag'>$tag</td><td class='c-chart'>$chart</td>")
    [void]$sb.Append("<td class='c-title'><a href='$link' target='_blank' rel='noopener'>$(HtmlEnc $row.Title)</a><ul class='cmt'>$cmt</ul></td>")
    [void]$sb.Append("<td class='r'>$($row.Pages)</td></tr>")
}
$rowsHtml = $sb.ToString()
if ($cAll -eq 0) { $rowsHtml = "<tr><td colspan='10' class='empty'>해당일($Date)에 기업 리포트가 없습니다.</td></tr>" }
$now = $kst.ToString('yyyy-MM-dd HH:mm:ss') + ' KST'

$html = @"
<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>당일 기업 리포트 · $Date</title>
<style>
:root{--up:#d32f2f;--dn:#1565c0;--new:#6a1b9a;--keep:#607d8b;--bg:#f5f6f8;--card:#fff;--line:#e6e8eb;--muted:#8a909a;--ink:#1a1d21}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:'Malgun Gothic','Apple SD Gothic Neo','Segoe UI',sans-serif}
.wrap{max-width:1320px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:21px;margin:0 0 3px}
.updated{display:inline-block;font-size:13px;font-weight:700;color:#7a4b00;background:#fff3cd;border:1px solid #ffe69c;border-radius:8px;padding:5px 11px;margin:2px 0 8px}
.sub{color:var(--muted);font-size:12.5px;margin-bottom:14px}
.chips{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.chip{padding:8px 14px;border:1px solid var(--line);background:var(--card);border-radius:20px;cursor:pointer;font-size:13px;font-weight:600;color:#55606b}
.chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}.chip .b{margin-left:6px;font-size:11px;opacity:.8}
.toolbar{margin:0 0 10px}#q{width:240px;max-width:60vw;padding:9px 12px;border:1px solid var(--line);border-radius:9px;font-size:14px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:10px 11px;text-align:left;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
th{background:#fafbfc;font-size:12px;color:#55606b;cursor:pointer;white-space:nowrap}
th.r,td.r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}tbody tr:hover td{background:#fcfcfd}
.tp{font-weight:700}.pup{color:var(--up);font-weight:700}.pdn{color:var(--dn);font-weight:700}
.code{display:block;font-size:11px;color:var(--muted)}.c-an{color:#444;max-width:110px;font-size:12px}
.tag{display:inline-block;font-size:11px;font-weight:700;border-radius:6px;padding:2px 7px;white-space:nowrap}
.a-up{color:#fff;background:var(--up)}.a-dn{color:#fff;background:var(--dn)}.a-new{color:#fff;background:var(--new)}
.a-keep{color:#fff;background:var(--keep)}.a-none{color:#999;background:#eee}.a-rec{color:#fff;background:#00897b}.a-flash{color:#fff;background:#ef6c00}
.c-title a{color:var(--ink);text-decoration:none;font-weight:600}.c-title a:hover{color:var(--up);text-decoration:underline}
.cmt{margin:5px 0 0;padding-left:15px;color:#566;font-size:11.5px;line-height:1.5}
.c-chart{width:154px}.spark{display:block}
.spark .sp-up{stroke:var(--up);fill:var(--up)}.spark .sp-dn{stroke:var(--dn);fill:var(--dn)}.spark .sp-fl{stroke:#888;fill:#888}
.spv{font-size:10px;fill:#555}.nochart{color:#bbb;font-size:11px}.empty{padding:46px;text-align:center;color:var(--muted)}
.foot{margin-top:13px;font-size:11px;color:var(--muted);line-height:1.6}
</style></head><body><div class="wrap">
<h1>📑 당일 기업 리포트</h1>
<div class="updated">🕒 마지막 업데이트: $now</div>
<div class="sub">기준일 $Date · 출처 FnGuide · 전체 $cAll건 · ☁ 클라우드 자동 갱신(하루 3회)</div>
<div class="chips">
<div class="chip on" data-f="all">전체<span class="b">$cAll</span></div>
<div class="chip" data-f="up">목표가 상향<span class="b">$cUp</span></div>
<div class="chip" data-f="dn">목표가 하향<span class="b">$cDn</span></div>
<div class="chip" data-f="new">신규<span class="b">$cNew</span></div>
<div class="chip" data-f="keep">유지<span class="b">$cKeep</span></div>
<div class="chip" data-f="rec">투자의견 변경<span class="b">$cRec</span></div>
</div>
<div class="toolbar"><input id="q" placeholder="종목·증권사·애널리스트 검색..." oninput="flt()"></div>
<table id="t"><thead><tr>
<th onclick="srt(0,'s')">종목</th><th onclick="srt(1,'s')">증권사</th><th>애널리스트</th>
<th>투자의견</th><th onclick="srt(4,'n')" class="r">목표가</th><th onclick="srt(5,'n')" class="r">상향폭</th>
<th>구분</th><th>목표가 추이</th><th>제목 / 요약</th><th onclick="srt(9,'n')" class="r">P</th>
</tr></thead><tbody>$rowsHtml</tbody></table>
<div class="foot">※ 제목 클릭 시 FnGuide 원문(로그인 필요). 구분 태그 = 각 증권사 직전 대비 목표가·투자의견 변화.<br>
※ '목표가 추이' 차트 = 해당 종목 발행 리포트 목표가 시계열(최근 약 3개월, 계정 제공 범위).</div>
</div>
<script>
var curF='all';
document.querySelectorAll('.chip').forEach(function(c){c.onclick=function(){document.querySelectorAll('.chip').forEach(function(x){x.classList.remove('on')});c.classList.add('on');curF=c.dataset.f;flt();}});
function show(r){if(curF==='all')return true;var p=r.getAttribute('data-prc'),rc=r.getAttribute('data-rec');
if(curF==='up')return p==='1';if(curF==='dn')return p==='3';if(curF==='new')return p==='4';if(curF==='keep')return p==='2';
if(curF==='rec')return rc==='1'||rc==='3'||rc==='4';return true;}
function flt(){var q=document.getElementById('q').value.toLowerCase();
document.querySelectorAll('#t tbody tr').forEach(function(r){var ok=show(r)&&r.innerText.toLowerCase().indexOf(q)>-1;r.style.display=ok?'':'none';});}
function srt(i,type){var tb=document.querySelector('#t tbody');var rows=[].slice.call(tb.rows);var key=i+type;var asc=tb.getAttribute('data-c')===key?false:true;
rows.sort(function(a,b){var x=a.cells[i].innerText.trim(),y=b.cells[i].innerText.trim();if(type==='n'){x=parseFloat(x.replace(/[^0-9.-]/g,''))||0;y=parseFloat(y.replace(/[^0-9.-]/g,''))||0;return asc?x-y:y-x;}return asc?x.localeCompare(y,'ko'):y.localeCompare(x,'ko');});
rows.forEach(function(r){tb.appendChild(r);});tb.setAttribute('data-c',asc?key:'');}
</script></body></html>
"@
[System.IO.File]::WriteAllText($OutFile, $html, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "완료: $OutFile (전체 $cAll · 상향 $cUp · 하향 $cDn · 신규 $cNew · 의견변경 $cRec)"
