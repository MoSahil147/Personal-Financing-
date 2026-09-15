// Single-user app based in the UAE - "today" should mean today in Asia/Dubai,
// not the server's own clock (Render runs in UTC, which can be a whole
// calendar day behind UAE time between midnight and ~4am local).
const TIME_ZONE = 'Asia/Dubai';

function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
}

module.exports = { todayISO };
