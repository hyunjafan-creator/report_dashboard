// sugup_dashboard.js — 국내 증시 수급 대시보드 생성기
//   출력: ★Report_dashboards\수급대시보드_YYYY-MM-DD.html
//   실행: node sugup_dashboard.js  (옵션 없음, 매 실행 시 전체 갱신)
//
// 데이터 소스 (2026-07 기준 실제 접근 가능 여부 확인 완료)
//   1) 지수 실시간/당일    : 네이버 polling API (장중 실시간, 장마감 후 종가)
//   2) 지수 확정 종가       : KRX 오픈API idx (전영업일 확정치, 보조 표기)
//   3) 예탁금·신용잔고 90일 : 네이버금융 증시자금동향(sise_deposit) — 금투협 집계 재게시
//   4) 투자자별 순매수      : 네이버금융 투자자별매매동향(investorDealTrendDay) — KOSCOM 집계
//      ※ '사모'는 네이버 분류상 '투신(사모)'로 투신과 합산 제공됨
//   5) 외국인/기관 순매매 상위 : 네이버금융 sise_deal_rank_iframe
//   6) 반대매매             : 금융투자협회 FreeSIS — 무인증 API 차단 상태(잠금 카드 표시)
//   7) 사모/연기금 개별 상위 : KRX 정보데이터시스템 — 로그인제 전환(잠금 카드 표시)
const fs = require('fs');
const path = require('path');

const OUT_DIR = 'C:\\Users\\drago\\Downloads\\claude_work\\★Report_dashboards';
const KRX_CFG = 'C:\\Users\\drago\\Downloads\\claude_work\\krx_agent\\config.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// KRX 오픈API 인증키: 환경변수(클라우드/GitHub Actions) 우선, 없으면 로컬 config.json
function getKrxKey() {
  if (process.env.KRX_AUTH_KEY) return process.env.KRX_AUTH_KEY;
  try { return JSON.parse(fs.readFileSync(KRX_CFG, 'utf8').replace(/^﻿/, '')).authKey; } catch (e) { return null; }
}
// --outfile <경로>: 지정 시 해당 파일 하나만 출력 (GitHub Actions에서 sugup.html 생성용)
const OUTFILE = (() => { const i = process.argv.indexOf('--outfile'); return i >= 0 ? process.argv[i + 1] : null; })();

// ---------- 공용 유틸 ----------
async function getText(url, euckr) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  if (!euckr) return await res.text();
  const buf = Buffer.from(await res.arrayBuffer());
  return new TextDecoder('euc-kr').decode(buf);
}
const num = (s) => { const v = parseFloat(String(s).replace(/,/g, '')); return isNaN(v) ? null : v; };
const fmt = (v, d = 0) => v == null ? '-' : v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
const signCls = (v) => v > 0 ? 'up' : v < 0 ? 'dn' : 'fl';
const signTxt = (v, d = 0) => (v > 0 ? '+' : '') + fmt(v, d);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }

// ---------- 1) 지수: 네이버 실시간 ----------
async function fetchRealtimeIndex() {
  const t = await getText('https://polling.finance.naver.com/api/realtime?query=SERVICE_INDEX:KOSPI,KOSDAQ');
  const j = JSON.parse(t);
  const out = {};
  for (const d of j.result.areas[0].datas) {
    out[d.cd] = {
      now: d.nv / 100, chg: d.cv / 100, rate: d.cr, state: d.ms, // OPEN=장중, CLOSE=마감
      high: d.hv / 100, low: d.lv / 100, amountM: d.aa, // aa: 거래대금(백만원)
    };
  }
  return out;
}

// ---------- 2) 지수 확정 종가: KRX 오픈API (전영업일) ----------
async function fetchKrxOfficialIndex() {
  const key = getKrxKey();
  if (!key) return null;
  const call = async (ep, basDd) => {
    try {
      const r = await fetch(`https://data-dbg.krx.co.kr/svc/apis/${ep}?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
      const j = await r.json();
      for (const k of Object.keys(j)) if (Array.isArray(j[k])) return j[k];
      return [];
    } catch (e) { return []; }
  };
  // 최근 7일 역탐색으로 최신 확정치 확보
  let d = new Date();
  for (let i = 0; i < 8; i++) {
    const basDd = ymd(d);
    const w = d.getUTCDay();
    d = new Date(d.getTime() - 86400000);
    if (w === 0 || w === 6) continue;
    const [kospi, kosdaq] = await Promise.all([call('idx/kospi_dd_trd', basDd), call('idx/kosdaq_dd_trd', basDd)]);
    const k1 = kospi.find(r => r.IDX_NM === '코스피' && r.CLSPRC_IDX);
    const k2 = kosdaq.find(r => r.IDX_NM === '코스닥' && r.CLSPRC_IDX);
    if (k1 || k2) return { basDd, kospi: k1 || null, kosdaq: k2 || null };
  }
  return null;
}

// ---------- 3) 예탁금·신용잔고 (90영업일) ----------
async function fetchDepositCredit(days = 90) {
  // 행 구조: <td class="date">26.07.10</td> 뒤로 rate_up/rate_down 클래스 td 10개
  //          [예탁금, 예탁금증감, 신용잔고, 신용증감, 주식형, 증감, 혼합형, 증감, 채권형, 증감] (단위 억원)
  //          증감 부호는 셀의 rate_down 클래스로 판별
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= 8 && rows.length < days; page++) {
    const t = await getText(`https://finance.naver.com/sise/sise_deposit.naver?page=${page}`, true);
    const trs = t.split(/<tr/).slice(1);
    for (const tr of trs) {
      const dm = tr.match(/class="date"[^>]*>([\d.]+)</);
      if (!dm || seen.has(dm[1])) continue;
      const cells = [...tr.matchAll(/<td[^>]*class="(rate_up|rate_down)[^"]*"[^>]*>\s*([\d,]+)\s*<\/td>/g)]
        .map(m => ({ v: num(m[2]), down: m[1] === 'rate_down' }));
      if (cells.length >= 4) {
        seen.add(dm[1]);
        rows.push({
          date: dm[1],
          deposit: cells[0].v, depositChg: cells[1].down ? -cells[1].v : cells[1].v,
          credit: cells[2].v, creditChg: cells[3].down ? -cells[3].v : cells[3].v,
        });
      }
    }
  }
  return rows.slice(0, days); // 최신순
}

// ---------- 4) 투자자별 순매수 (당일/최근영업일) ----------
async function fetchInvestorTrend(sosok) { // '01' KOSPI, '02' KOSDAQ
  const bizdate = ymd(new Date());
  const t = await getText(`https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=${sosok}`, true);
  const trs = t.split(/<tr/).slice(1);
  const out = [];
  for (const tr of trs) {
    const dm = tr.match(/class="date2?"[^>]*>([\d.]+)</);
    if (!dm) continue;
    const nums = [...tr.matchAll(/<td[^>]*>\s*(-?[\d,]+)\s*<\/td>/g)].map(m => num(m[1]));
    if (nums.length >= 10) {
      // 순서: 개인 외국인 기관계 금융투자 보험 투신(사모) 은행 기타금융 연기금등 기타법인
      out.push({
        date: dm[1], 개인: nums[0], 외국인: nums[1], 기관계: nums[2], 금융투자: nums[3],
        보험: nums[4], 투신사모: nums[5], 은행: nums[6], 기타금융: nums[7], 연기금등: nums[8], 기타법인: nums[9],
      });
    }
  }
  return out; // 최신순, [0]이 최근 영업일
}

// ---------- 5) 외국인/기관 순매매 상위 ----------
async function fetchDealRank(sosok, gubun, type) { // gubun: 9000 외국인 / 1000 기관, type: buy/sell
  // iframe 안에 [이전 영업일, 최근 영업일] 두 날짜 섹션(sise_guide_date)이 순서대로 있음 → 마지막 섹션이 최신
  // 행: 종목링크 + <td class="number">수량(천주, 매도는 음수)</td><td class="number">금액(백만원)</td><td class="number">당일거래량(주)</td>
  const t = await getText(`https://finance.naver.com/sise/sise_deal_rank_iframe.naver?sosok=${sosok}&investor_gubun=${gubun}&type=${type}`, true);
  const secs = t.split(/sise_guide_date"?>/).slice(1);
  if (!secs.length) return { date: null, rows: [] };
  const last = secs[secs.length - 1];
  const date = (last.match(/^([\d.]+)/) || [])[1] || null;
  const out = [];
  for (const tr of last.split(/<tr/).slice(1)) {
    const cm = tr.match(/code=(\d{6})[^>]*>([^<]+)</);
    if (!cm) continue;
    const nums = [...tr.matchAll(/<td[^>]*class="number"[^>]*>\s*(-?[\d,]+)\s*<\/td>/g)].map(m => num(m[1]));
    if (nums.length >= 3) {
      out.push({ code: cm[1], name: cm[2].trim(), qtyK: Math.abs(nums[0]), amtM: Math.abs(nums[1]), vol: nums[2] });
    }
  }
  return { date, rows: out };
}

// ---------- 5.5) KRX 종목별 거래대금 (수급강도 분모용, 기준일 확정치) ----------
async function fetchKrxTradeValueMap(basDd) {
  const key = getKrxKey();
  if (!key) return {};
  const map = {};
  for (const ep of ['sto/stk_bydd_trd', 'sto/ksq_bydd_trd', 'etp/etf_bydd_trd']) {
    try {
      const r = await fetch(`https://data-dbg.krx.co.kr/svc/apis/${ep}?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
      const j = await r.json();
      const rows = Object.values(j).find(Array.isArray) || [];
      for (const row of rows) if (row.ISU_CD) map[row.ISU_CD] = { trdval: num(row.ACC_TRDVAL), close: num(row.TDD_CLSPRC), flucRt: num(row.FLUC_RT) };
    } catch (e) { /* 실패 시 해당 시장만 누락 */ }
  }
  return map;
}

// ---------- SVG 라인차트 ----------
function svgChart(series, { width = 560, height = 190, unitDiv = 10000, unitLabel = '조원', color = '#4f8ef7' } = {}) {
  // series: [{date, v}] 과거→최신 순으로 정렬해 전달
  const pad = { l: 46, r: 14, t: 14, b: 24 };
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const vals = series.map(s => s.v / unitDiv);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const rng = (mx - mn) || 1;
  const x = (i) => pad.l + (i / (series.length - 1)) * W;
  const y = (v) => pad.t + H - ((v - mn) / rng) * H;
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${pad.l},${pad.t + H} ${pts} ${(pad.l + W).toFixed(1)},${pad.t + H}`;
  // x축 라벨: 처음/중간/끝
  const xi = [0, Math.floor(series.length / 2), series.length - 1];
  const xLabels = xi.map(i => `<text x="${x(i).toFixed(1)}" y="${height - 6}" class="axl" text-anchor="${i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}">${series[i].date}</text>`).join('');
  const yl = [mn, mn + rng / 2, mx];
  const yLabels = yl.map(v => `<text x="${pad.l - 6}" y="${(y(v) + 3.5).toFixed(1)}" class="axl" text-anchor="end">${fmt(v, 1)}</text>`).join('');
  const yGrid = yl.map(v => `<line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${pad.l + W}" y2="${y(v).toFixed(1)}" class="grid"/>`).join('');
  const last = series[series.length - 1];
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    ${yGrid}
    <polygon points="${area}" fill="${color}" opacity="0.10"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>
    <circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(last.v / unitDiv).toFixed(1)}" r="3.5" fill="${color}"/>
    ${xLabels}${yLabels}
    <text x="${pad.l}" y="${pad.t - 2}" class="axl">${unitLabel}</text>
  </svg>`;
}

// ---------- HTML 렌더링 ----------
function render(data) {
  const { rt, krx, dep, invK, invQ, ranks, trdvalMap, now } = data;
  const kospi = rt.KOSPI, kosdaq = rt.KOSDAQ;
  const stateTxt = kospi.state === 'OPEN' ? '장중' : '장마감';
  const invKr = invK[0], invQr = invQ[0];

  // 예탁금/신용 차트 (과거→최신)
  const depAsc = [...dep].reverse();
  const depChart = svgChart(depAsc.map(r => ({ date: r.date, v: r.deposit })), { color: '#4f8ef7' });
  const crdChart = svgChart(depAsc.map(r => ({ date: r.date, v: r.credit })), { color: '#e2a03f' });
  const d0 = dep[0];

  // 주체별 표 행 (사용자 요청 6주체 + 참고)
  const invRow = (label, k, q, note) => {
    const kv = k == null ? null : k, qv = q == null ? null : q;
    return `<tr><td class="lbl">${label}${note ? `<span class="note">${note}</span>` : ''}</td>
      <td class="${signCls(kv)}">${kv == null ? '-' : signTxt(kv)}</td>
      <td class="${signCls(qv)}">${qv == null ? '-' : signTxt(qv)}</td></tr>`;
  };

  // 순매매 상위: 시장 합산 후 금액순 top5 (기준일: 네이버 순위표 최신 확정일)
  const rankDate = ranks.f01b.date || ranks.i01b.date || '-';
  const mergeTop = (a, b) => [...a.rows, ...b.rows].sort((x, y) => y.amtM - x.amtM).slice(0, 5);
  const frgBuy = mergeTop(ranks.f01b, ranks.f02b), frgSell = mergeTop(ranks.f01s, ranks.f02s);
  const insBuy = mergeTop(ranks.i01b, ranks.i02b), insSell = mergeTop(ranks.i01s, ranks.i02s);

  const rankTable = (rows, dir) => `<table class="rank">
    <tr><th>종목</th><th>금액(억원)</th><th>수량(천주)</th></tr>
    ${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="${dir}">${dir === 'up' ? '+' : '-'}${fmt(r.amtM / 100, 0)}</td><td>${fmt(r.qtyK)}</td></tr>`).join('')}
  </table>`;

  // 수급강도: 순매수금액 ÷ 기준일 거래대금 (외국인+기관 합산, 동일종목 합산)
  //   ※ 순위표의 '당일거래량' 컬럼은 조회 시점(오늘 장중) 거래량이라 분모로 부적합 → KRX 확정 거래대금 사용
  const strength = (buyLists, sellLists) => {
    const agg = (lists) => {
      const m = new Map();
      for (const r of lists.map(l => l.rows).flat()) {
        const cur = m.get(r.code) || { code: r.code, name: r.name, amtM: 0 };
        cur.amtM += r.amtM;
        m.set(r.code, cur);
      }
      return [...m.values()]
        .filter(r => r.amtM >= 5000) // 순매수 50억원 미만 초소형 노이즈 제외
        .map(r => { const tv = trdvalMap[r.code]; return { ...r, trdval: tv ? tv.trdval : null }; })
        .filter(r => r.trdval > 0)
        .map(r => ({ ...r, ratio: r.amtM * 1000000 / r.trdval * 100 }))
        .sort((a, b) => b.ratio - a.ratio).slice(0, 5);
    };
    return { top: agg(buyLists), bottom: agg(sellLists) };
  };
  const st = strength([ranks.f01b, ranks.f02b, ranks.i01b, ranks.i02b], [ranks.f01s, ranks.f02s, ranks.i01s, ranks.i02s]);
  const stTable = (rows, dir) => `<table class="rank">
    <tr><th>종목</th><th>거래대금 대비</th><th>금액(억원)</th></tr>
    ${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="${dir}">${dir === 'up' ? '+' : '-'}${fmt(r.ratio, 1)}%</td><td>${fmt(r.amtM / 100)}</td></tr>`).join('')}
  </table>`;

  const idxCard = (name, o, official) => `
    <div class="card idx">
      <div class="ttl">${name} <span class="tag">${stateTxt}</span></div>
      <div class="big ${signCls(o.chg)}">${fmt(o.now, 2)}</div>
      <div class="sub ${signCls(o.chg)}">${signTxt(o.chg, 2)} (${signTxt(o.rate, 2)}%)</div>
      <div class="mini">고가 ${fmt(o.high, 2)} · 저가 ${fmt(o.low, 2)} · 거래대금 ${fmt(o.amountM / 1000000, 1)}조원</div>
      ${official ? `<div class="mini dim">전영업일 확정(KRX ${official.BAS_DD}): ${fmt(num(official.CLSPRC_IDX), 2)} (${signTxt(num(official.FLUC_RT), 2)}%)</div>` : ''}
    </div>`;

  const lockedCard = (title, body) => `
    <div class="card locked">
      <div class="ttl">${title} <span class="tag lock">잠금</span></div>
      <div class="lockbody">${body}</div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>수급 대시보드 ${now.slice(0, 10)}</title>
<style>
  :root { --bg:#0f1420; --card:#171e2e; --line:#232c42; --tx:#dbe4f5; --dim:#8492ad;
          --up:#f4516c; --dn:#3d8bfd; --fl:#8492ad; --acc:#4f8ef7; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--tx); font-family:'Malgun Gothic','Segoe UI',sans-serif; padding:22px; }
  h1 { font-size:21px; margin-bottom:4px; }
  .meta { color:var(--dim); font-size:12px; margin-bottom:18px; }
  .grid { display:grid; gap:14px; margin-bottom:14px; }
  .g4 { grid-template-columns:repeat(4,1fr); }
  .g3 { grid-template-columns:repeat(3,1fr); }
  .g2 { grid-template-columns:repeat(2,1fr); }
  @media (max-width:1100px){ .g4{grid-template-columns:repeat(2,1fr);} .g3{grid-template-columns:1fr;} .g2{grid-template-columns:1fr;} }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
  .ttl { font-size:13px; color:var(--dim); font-weight:bold; margin-bottom:10px; }
  .tag { background:#233150; color:#7fa8ef; font-size:10px; padding:2px 7px; border-radius:8px; margin-left:6px; vertical-align:1px; }
  .tag.lock { background:#3a2a35; color:#d99; }
  .big { font-size:28px; font-weight:bold; }
  .sub { font-size:14px; margin-top:2px; }
  .mini { font-size:11px; color:var(--dim); margin-top:8px; line-height:1.6; }
  .mini.dim { opacity:.8; }
  .up { color:var(--up); } .dn { color:var(--dn); } .fl { color:var(--fl); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { color:var(--dim); font-weight:normal; font-size:11px; text-align:right; padding:4px 6px; border-bottom:1px solid var(--line); }
  th:first-child { text-align:left; }
  td { padding:6px; text-align:right; border-bottom:1px solid var(--line); }
  td:first-child { text-align:left; }
  tr:last-child td { border-bottom:none; }
  td.lbl { color:var(--tx); }
  .note { color:var(--dim); font-size:10px; margin-left:5px; }
  .rank td:first-child { max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  svg { width:100%; height:auto; display:block; }
  .axl { font-size:10px; fill:var(--dim); font-family:'Malgun Gothic',sans-serif; }
  .grid line, line.grid { stroke:var(--line); stroke-width:1; }
  .chstat { font-size:12px; color:var(--dim); margin-bottom:8px; }
  .chstat b { color:var(--tx); font-size:15px; }
  .lockbody { font-size:12px; color:var(--dim); line-height:1.8; }
  .sec { font-size:14px; font-weight:bold; margin:22px 0 10px; color:#aebfdd; }
  .src { color:var(--dim); font-size:11px; line-height:1.8; margin-top:20px; border-top:1px solid var(--line); padding-top:12px; }
</style></head><body>
<h1>국내 증시 수급 대시보드</h1>
<div class="meta">갱신: ${now} · 지수 ${stateTxt} 기준 · 투자자별 순매수 기준일 ${invKr ? invKr.date : '-'} · 예탁금/신용 최신일 ${d0 ? d0.date : '-'}</div>

<div class="grid g4">
  ${idxCard('코스피', kospi, krx && krx.kospi)}
  ${idxCard('코스닥', kosdaq, krx && krx.kosdaq)}
  <div class="card">
    <div class="ttl">투자자예탁금 <span class="tag">${d0 ? d0.date : '-'}</span></div>
    <div class="big">${d0 ? fmt(d0.deposit / 10000, 1) : '-'}<span style="font-size:15px"> 조원</span></div>
    <div class="sub ${d0 ? signCls(d0.depositChg) : 'fl'}">${d0 ? signTxt(d0.depositChg / 10000, 2) + ' 조원 (전일비)' : ''}</div>
    <div class="mini">90영업일 최고 ${fmt(Math.max(...dep.map(r => r.deposit)) / 10000, 1)}조 · 최저 ${fmt(Math.min(...dep.map(r => r.deposit)) / 10000, 1)}조</div>
  </div>
  <div class="card">
    <div class="ttl">신용거래융자 잔고 <span class="tag">${d0 ? d0.date : '-'}</span></div>
    <div class="big">${d0 ? fmt(d0.credit / 10000, 1) : '-'}<span style="font-size:15px"> 조원</span></div>
    <div class="sub ${d0 ? signCls(d0.creditChg) : 'fl'}">${d0 ? signTxt(d0.creditChg / 10000, 2) + ' 조원 (전일비)' : ''}</div>
    <div class="mini">90영업일 최고 ${fmt(Math.max(...dep.map(r => r.credit)) / 10000, 1)}조 · 최저 ${fmt(Math.min(...dep.map(r => r.credit)) / 10000, 1)}조</div>
  </div>
</div>

<div class="sec">당일 투자자별 순매수 (억원) — 기준일 ${invKr ? invKr.date : '-'}</div>
<div class="grid g2">
  <div class="card">
    <div class="ttl">주요 주체</div>
    <table>
      <tr><th>주체</th><th>코스피</th><th>코스닥</th></tr>
      ${invRow('개인', invKr && invKr.개인, invQr && invQr.개인)}
      ${invRow('외국인', invKr && invKr.외국인, invQr && invQr.외국인)}
      ${invRow('연기금등', invKr && invKr.연기금등, invQr && invQr.연기금등)}
      ${invRow('투신(사모 포함)', invKr && invKr.투신사모, invQr && invQr.투신사모, '네이버 분류상 사모+투신 합산')}
      ${invRow('금융투자', invKr && invKr.금융투자, invQr && invQr.금융투자)}
      ${invRow('기관계', invKr && invKr.기관계, invQr && invQr.기관계)}
    </table>
  </div>
  <div class="card">
    <div class="ttl">기타 주체 (참고)</div>
    <table>
      <tr><th>주체</th><th>코스피</th><th>코스닥</th></tr>
      ${invRow('보험', invKr && invKr.보험, invQr && invQr.보험)}
      ${invRow('은행', invKr && invKr.은행, invQr && invQr.은행)}
      ${invRow('기타금융', invKr && invKr.기타금융, invQr && invQr.기타금융)}
      ${invRow('기타법인', invKr && invKr.기타법인, invQr && invQr.기타법인)}
    </table>
    <div class="mini">사모펀드 단독 수치는 KRX 정보데이터시스템 로그인 전용으로 전환되어 현재 무료 소스가 없습니다. 네이버(KOSCOM) 분류는 투신(사모) 합산 기준.</div>
  </div>
</div>

<div class="sec">시장 유동성 — 최근 90영업일</div>
<div class="grid g3">
  <div class="card">
    <div class="ttl">투자자예탁금 추이</div>
    <div class="chstat"><b>${d0 ? fmt(d0.deposit / 10000, 1) : '-'}조원</b> (${d0 ? signTxt(d0.depositChg, 0) : '-'}억)</div>
    ${depChart}
  </div>
  <div class="card">
    <div class="ttl">신용거래융자 잔고 추이</div>
    <div class="chstat"><b>${d0 ? fmt(d0.credit / 10000, 1) : '-'}조원</b> (${d0 ? signTxt(d0.creditChg, 0) : '-'}억)</div>
    ${crdChart}
  </div>
  ${lockedCard('전일 반대매매 / 예탁금 대비 비율', `
    금융투자협회(FreeSIS) 반대매매 통계는 사이트 리뉴얼로 무인증 API가 차단되어 현재 자동 수집이 불가합니다.<br>
    · 수동 확인: <a href="https://freesis.kofia.or.kr/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000060" style="color:#7fa8ef">FreeSIS &gt; 주식 &gt; 증시자금추이</a><br>
    · 연동 재개 조건: FreeSIS 신규 API 경로 확보 시 이 카드에 자동 표시되도록 코드가 준비되어 있습니다.`)}
</div>

<div class="sec">주체별 순매매 상위 top5 — 기준일 ${rankDate} (코스피+코스닥 통합, 금액 기준)</div>
<div class="grid g2">
  <div class="card"><div class="ttl">외국인 순매수 top5</div>${rankTable(frgBuy, 'up')}</div>
  <div class="card"><div class="ttl">외국인 순매도 top5</div>${rankTable(frgSell, 'dn')}</div>
  <div class="card"><div class="ttl">기관 순매수 top5</div>${rankTable(insBuy, 'up')}</div>
  <div class="card"><div class="ttl">기관 순매도 top5</div>${rankTable(insSell, 'dn')}</div>
</div>
<div class="grid g2">
  ${lockedCard('사모펀드 순매수/순매도 top5', `
    KRX 정보데이터시스템(data.krx.co.kr)이 로그인제(KRX Data Marketplace)로 전환되어 주체별 상세 상위종목 무료 조회가 막혔습니다.<br>
    해제 방법 (둘 중 하나):<br>
    · KRX Data Marketplace 계정 생성 후 알려주시면 로그인 연동<br>
    · 키움 OpenAPI 포털(openapi.kiwoom.com)에 현재 공인IP 재등록 → 키움 ka10058(투자자별일별매매종목)로 연동`)}
  ${lockedCard('연기금 순매수/순매도 top5', `
    사모펀드와 동일한 잠금입니다. 키움 REST의 ka10058 TR이 연기금·사모 등 주체별 일별 매매 상위종목을 제공하므로,<br>
    키움 IP 재등록(현재 8050 오류 = 유동IP 변경으로 포털 등록 IP 불일치)만 되면 이 두 섹션과 3주체 수급강도까지 자동 활성화되도록 확장 예정입니다.`)}
</div>

<div class="sec">수급 강도 top5 — 기준일 ${rankDate} (외국인+기관 순매수금액 ÷ 해당일 거래대금, KRX 확정치)</div>
<div class="grid g2">
  <div class="card"><div class="ttl">매수 강도 상위 <span class="tag">그날 거래대금의 몇 %를 순매수했나</span></div>${stTable(st.top, 'up')}</div>
  <div class="card"><div class="ttl">매도 강도 상위</div>${stTable(st.bottom, 'dn')}</div>
</div>
<div class="mini" style="margin-top:-6px">※ 요청하신 외국인·사모·연기금 3주체 기준 수급강도는 사모/연기금 상위종목 데이터가 잠금 상태라, 현재는 외국인+기관 합산으로 산출합니다. KRX 로그인 또는 키움 단말기 해제 시 3주체 기준으로 전환됩니다.</div>

<div class="src">
  소스: 지수 네이버 실시간(KOSCOM) + KRX 오픈API 확정치 · 예탁금/신용잔고 네이버 증시자금동향(금융투자협회 집계) · 투자자별 순매수 네이버 투자자별매매동향(KOSCOM) · 순매매 상위 네이버 외국인/기관 순매매 상위<br>
  단위: 순매수 억원 · 예탁금/신용 조원 · 상위종목 금액 억원, 수량 천주 · 생성 스크립트: claude_work\\sugup_agent\\sugup_dashboard.js
</div>
</body></html>`;
}

// ---------- 메인 ----------
(async () => {
  const t0 = Date.now();
  console.log('[1/6] 지수(실시간/확정) 수집...');
  const [rt, krx] = await Promise.all([fetchRealtimeIndex(), fetchKrxOfficialIndex()]);
  console.log('[2/6] 예탁금/신용잔고 90영업일 수집...');
  const dep = await fetchDepositCredit(90);
  console.log(`      ${dep.length}일 (${dep[dep.length - 1]?.date} ~ ${dep[0]?.date})`);
  console.log('[3/6] 투자자별 순매수 수집...');
  const [invK, invQ] = await Promise.all([fetchInvestorTrend('01'), fetchInvestorTrend('02')]);
  console.log('[4/6] 외국인/기관 순매매 상위 수집...');
  const [f01b, f01s, f02b, f02s, i01b, i01s, i02b, i02s] = await Promise.all([
    fetchDealRank('01', '9000', 'buy'), fetchDealRank('01', '9000', 'sell'),
    fetchDealRank('02', '9000', 'buy'), fetchDealRank('02', '9000', 'sell'),
    fetchDealRank('01', '1000', 'buy'), fetchDealRank('01', '1000', 'sell'),
    fetchDealRank('02', '1000', 'buy'), fetchDealRank('02', '1000', 'sell'),
  ]);
  const rankDateRaw = f01b.date || i01b.date; // '26.07.13' → '20260713'
  const basDd = rankDateRaw ? '20' + rankDateRaw.replace(/\./g, '') : null;
  console.log(`[5/6] KRX 종목별 거래대금 수집 (기준일 ${basDd})...`);
  const trdvalMap = basDd ? await fetchKrxTradeValueMap(basDd) : {};
  console.log(`      ${Object.keys(trdvalMap).length}종목`);
  console.log('[6/6] HTML 생성...');
  const now = new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' KST';
  const html = render({ rt, krx, dep, invK, invQ, ranks: { f01b, f01s, f02b, f02s, i01b, i01s, i02b, i02s }, trdvalMap, now });
  let out;
  if (OUTFILE) { // 클라우드(GitHub Actions) 모드: 단일 파일만 출력
    out = OUTFILE;
    fs.writeFileSync(out, html, 'utf8');
  } else {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    out = path.join(OUT_DIR, `수급대시보드_${now.slice(0, 10)}.html`);
    fs.writeFileSync(out, html, 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, '수급대시보드_최신.html'), html, 'utf8'); // 배치파일이 여는 고정 파일명
  }
  console.log(`완료 (${((Date.now() - t0) / 1000).toFixed(1)}s): ${out}`);
  console.log('OUTFILE=' + out);
  if (process.argv.includes('--open')) {
    require('child_process').spawn('cmd', ['/c', 'start', '', path.join(OUT_DIR, '수급대시보드_최신.html')], { detached: true, stdio: 'ignore' }).unref();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
