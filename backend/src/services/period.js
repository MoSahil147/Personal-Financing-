// Works out which dates a monthly report covers. Pure date math on
// "YYYY-MM-DD" strings, so it can be tested without a database.

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// 'calendar': the 1st to the last day of the month (or today, if it isn't over).
// 'salary':   from the salary logged in that month up to the day before the
//             next salary (or today, if the next one hasn't come yet) - the
//             salary arrives near the end of the month, so this is the real
//             budget month. `salaryDates` are every salary's entry_date.
// `to` is inclusive; `inProgress` means the period hasn't finished yet.
function reportRange({ year, month, cycle, today, salaryDates = [] }) {
  const mm = String(month).padStart(2, '0');
  const monthStart = `${year}-${mm}-01`;
  const nextMonthStart = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  if (cycle === 'salary') {
    const sorted = [...salaryDates].sort();
    const from = sorted.filter((d) => d >= monthStart && d < nextMonthStart).pop();
    if (!from) return { error: 'No salary was logged in that month.' };
    const next = sorted.find((d) => d > from);
    const to = next ? addDays(next, -1) : today;
    return { from, to: to < from ? from : to, inProgress: !next };
  }

  const lastDay = addDays(nextMonthStart, -1);
  const inProgress = today >= monthStart && today < lastDay;
  return { from: monthStart, to: inProgress ? today : lastDay, inProgress };
}

module.exports = { reportRange, addDays };
