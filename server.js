import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ============================================================
// 세션 설정 — .env 파일에서 로드, index.html 세션 설정에서도 변경 가능
// ============================================================
const { MEMB_NO, KHRF, PORT = "3000" } = process.env;
if (!MEMB_NO || !KHRF) {
  console.error("오류: .env 파일에 MEMB_NO와 KHRF를 설정하세요 (.env.example 참고)");
  process.exit(1);
}

const session = {
  memb_no: MEMB_NO,
  khrf: KHRF,
};

const BASE_URL = "https://www.kensington.co.kr";
const NO_ROOM = ["객실이 없습니다", "조회된 객실이 없", "예약 가능한 객실이 없"];

// ============================================================
// Kensington API
// ============================================================
function makeClient() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      "Referer": `${BASE_URL}/reservation/quick_member`,
      "X-Requested-With": "XMLHttpRequest",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "Cookie": `khrf=${session.khrf}`,
    },
  });
}

function extractKhrf(response) {
  const setCookie = response.headers["set-cookie"] ?? [];
  for (const cookie of setCookie) {
    const match = cookie.match(/^khrf=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

async function checkRooms({ bran_cd, checkin, checkout, adult_cnt = 2, child_cnt = 0 }) {
  const client = makeClient();
  const urlEncoded = { headers: { "Content-Type": "application/x-www-form-urlencoded" } };
  const form = (obj) => new URLSearchParams(obj).toString();

  const r1 = await client.post("/reservation/membno_select", form({ memb_no: session.memb_no }), urlEncoded);
  const r2 = await client.post("/reservation/branch_select", form({ bran_cd, memb_no: session.memb_no }), urlEncoded);

  // 응답마다 서버가 갱신해주는 khrf를 반영해 세션을 자동 연장
  const refreshed = extractKhrf(r2) ?? extractKhrf(r1);
  if (refreshed) session.khrf = refreshed;

  const params = new URLSearchParams({
    search_bran_cd: bran_cd,
    search_stay_start_dt: checkin,
    search_stay_end_dt: checkout,
    search_room_cnt: 1,
    search_people_adult_cnt: adult_cnt,
    search_people_adult_cnts: adult_cnt,
    search_people_child_cnt: child_cnt,
    search_people_child_cnts: child_cnt,
    search_code_type: "",
    search_code: "",
    pack_cd: "",
    room_type_cd: "",
    memb_no: session.memb_no,
    pay_type: "D",
  });

  const roomResp = await client.get(`/reservation/quick_roomdata_member/?${params}`);
  const refined = extractKhrf(roomResp);
  if (refined) session.khrf = refined;
  const html = roomResp.data;

  const finalUrl = roomResp.request?.res?.responseUrl ?? "";
  if (!finalUrl.includes("quick_roomdata_member")) return { status: "session_expired" };

  if (html.slice(0, 1000).includes("로그인")) return { status: "session_expired" };

  const $ = cheerio.load(html);
  const text = $.text();

  if (NO_ROOM.some((p) => text.includes(p))) return { status: "none" };

  const els = $(".item_list li.item.room");
  if (els.length > 0) {
    const rooms = els.map((_, el) => {
      const name = $(el).find(".title span").first().text().trim();
      const price = $(el).find(".price .num").text().trim();
      return price ? `${name} (₩${price}~)` : name;
    }).get();
    return { status: "available", rooms };
  }

  return { status: "none" };
}

// ============================================================
// Routes
// ============================================================
app.get("/", (_, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/branches", (_, res) => res.sendFile(join(__dirname, "branch-code.json")));

// SSO 로그인 콜백 — SSO가 returnUrl로 리다이렉트하면 여기서 khrf 캡처
app.all("/login-callback", async (req, res) => {
  const params = { ...req.query, ...req.body };
  try {
    const r = await axios.get(`${BASE_URL}/proc/login_result`, {
      params,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "Referer": `${BASE_URL}/member/login`,
      },
      maxRedirects: 5,
    });
    const khrf = extractKhrf(r);
    if (khrf) {
      session.khrf = khrf;
      const safe = JSON.stringify(khrf);
      res.send(`<!doctype html><html><body><script>
        if (window.opener) window.opener.postMessage({type:'khrf',khrf:${safe}},'*');
        document.write('<p>로그인 완료! 이 창을 닫아주세요.</p>');
        setTimeout(() => window.close(), 1000);
      </script></body></html>`);
    } else {
      res.send("<!doctype html><html><body><p>로그인은 됐지만 khrf를 가져오지 못했습니다. 수동으로 복사해 주세요.</p></body></html>");
    }
  } catch (e) {
    res.send(`<!doctype html><html><body><p>오류: ${e.message}</p></body></html>`);
  }
});

app.post("/api/session", (req, res) => {
  const { khrf, memb_no } = req.body;
  if (khrf) session.khrf = khrf.trim();
  if (memb_no) session.memb_no = memb_no.trim();
  res.json({ ok: true });
});

app.get("/api/monitor", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const { bran_cd, checkin, checkout, adult_cnt = 2, child_cnt = 0, interval = 5 } = req.query;
  const intervalMs = Number(interval) * 60 * 1000;

  let active = true;
  req.on("close", () => { active = false; });

  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  let count = 0;
  while (active) {
    count++;
    try {
      const result = await checkRooms({ bran_cd, checkin, checkout, adult_cnt, child_cnt });
      send({ count, time: new Date().toTimeString().slice(0, 8), ...result });
      if (result.status === "session_expired") break;
    } catch (e) {
      send({ count, time: new Date().toTimeString().slice(0, 8), status: "error", message: e.message });
    }

    // 설정 간격 ±20% 범위에서 초 단위로 무작위 대기
    const intervalSec = Number(interval) * 60;
    const minSec = Math.floor(intervalSec * 0.8);
    const maxSec = Math.floor(intervalSec * 1.2);
    const waitSec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
    const until = Date.now() + waitSec * 1000;
    while (active && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  res.end();
});

app.listen(Number(PORT), () => console.log(`http://localhost:${PORT}`));
