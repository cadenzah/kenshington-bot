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

async function checkRooms({ bran_cd, checkin, checkout, adult_cnt = 2, child_cnt = 0 }) {
  const client = makeClient();
  const urlEncoded = { headers: { "Content-Type": "application/x-www-form-urlencoded" } };
  const form = (obj) => new URLSearchParams(obj).toString();

  await client.post("/reservation/membno_select", form({ memb_no: session.memb_no }), urlEncoded);
  await client.post("/reservation/branch_select", form({ bran_cd, memb_no: session.memb_no }), urlEncoded);

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

  const { data: html } = await client.get(`/reservation/quick_roomdata_member/?${params}`);

  if (html.slice(0, 1000).includes("로그인")) return { status: "session_expired" };

  const $ = cheerio.load(html);
  const text = $.text();

  if (NO_ROOM.some((p) => text.includes(p))) return { status: "none" };

  const selectors = [".room_item", ".room_wrap li", ".list_room li", "[class*='room_list'] li"];
  for (const sel of selectors) {
    const els = $(sel);
    if (els.length > 0) {
      const rooms = els.map((_, el) => $(el).text().trim().replace(/\s+/g, " ").slice(0, 100)).get();
      return { status: "available", rooms };
    }
  }

  return { status: "unknown", hint: "객실 셀렉터 미매칭 — debug_response.html 확인" };
}

// ============================================================
// Routes
// ============================================================
app.get("/", (_, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/branches", (_, res) => res.sendFile(join(__dirname, "branch-code.json")));

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

    const until = Date.now() + intervalMs;
    while (active && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  res.end();
});

app.listen(Number(PORT), () => console.log(`http://localhost:${PORT}`));
