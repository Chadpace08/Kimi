// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

const now = new Date(2026, 9, 1, 10, 30); // Thu, 1 Oct 2026 10:30
const P = s => C.parse(s, { now, currency: 'PHP' });

test('pay bill on a date', () => {
  const r = P('Remind me to pay my bill on October 15.');
  assert.equal(r.title, 'Pay my bill');
  assert.equal(r.type, 'bill');
  assert.equal(r.due, '2026-10-15T09:00');
  assert.equal(r.repeat, null);
});

test('monthly subscription with amount', () => {
  const r = P('My Canva subscription is 1,299 pesos monthly, remind me every month.');
  assert.equal(r.title, 'Canva subscription');
  assert.equal(r.type, 'subscription');
  assert.equal(r.amount, 1299);
  assert.equal(r.currency, 'PHP');
  assert.equal(r.repeat.freq, 'month');
});

test('tomorrow morning', () => {
  const r = P('Remind me tomorrow morning to send the invoice.');
  assert.equal(r.title, 'Send the invoice');
  assert.equal(r.type, 'task');
  assert.equal(r.due, '2026-10-02T09:00');
});

test('month only', () => {
  const r = P('I need to renew my domain in December.');
  assert.equal(r.title, 'Renew my domain');
  assert.equal(r.due, '2026-12-01T09:00');
});

test('every Friday', () => {
  const r = P('Remind me every Friday to check my bookkeeping.');
  assert.equal(r.title, 'Check my bookkeeping');
  assert.deepEqual(r.repeat, { freq: 'week', n: 1 });
  assert.equal(C.fromLocal(r.due).getDay(), 5);
});

test('relative minutes and explicit times', () => {
  assert.equal(P('remind me in 20 minutes to take out the laundry').due, '2026-10-01T10:50');
  assert.equal(P('remind me at 3 to call the bank').due, '2026-10-01T15:00');
  assert.equal(P('submit BAS on October 28 at 2pm').due, '2026-10-28T14:00');
  assert.equal(P('remind me to call yen at 7 tonight').due, '2026-10-01T19:00');
});

test('monthly day anchor and bare amount', () => {
  const r = P('pay Globe postpaid 1799 on the 15th every month');
  assert.equal(r.amount, 1799);
  assert.equal(r.repeat.day, 15);
  assert.equal(r.due, '2026-10-15T09:00');
});

test('no time given is flagged as a guess', () => {
  assert.equal(P('call mom').guessed, true);
});

test('completing a repeating bill advances one period', () => {
  const rem = { id: 'x', type: 'bill', title: 'Rent', due: '2026-10-05T09:00', repeat: { freq: 'month', n: 1 } };
  C.completeReminder(rem, now);
  assert.equal(rem.due, '2026-11-05T09:00');
  const eom = { id: 'y', type: 'bill', title: 'X', due: '2026-01-31T09:00', repeat: { freq: 'month', n: 1, day: 31 } };
  C.completeReminder(eom, now);
  assert.equal(eom.due, '2026-02-28T09:00');
  C.completeReminder(eom, now);
  assert.equal(eom.due, '2026-03-31T09:00');
});

test('completing an overdue repeating task skips to the future', () => {
  const rem = { id: 'z', type: 'task', title: 'Check books', due: '2026-09-04T09:00', repeat: { freq: 'week', n: 1 } };
  C.completeReminder(rem, now);
  assert.equal(rem.due, '2026-10-02T09:00');
});

test('snooze keeps the schedule anchor', () => {
  const rem = { id: 's', type: 'bill', title: 'Rent', due: '2026-10-05T09:00', repeat: { freq: 'month', n: 1 } };
  C.snoozeReminder(rem, new Date(2026, 9, 6, 9, 0));
  assert.equal(rem.due, '2026-10-06T09:00');
  C.completeReminder(rem, now);
  assert.equal(rem.due, '2026-11-05T09:00');
});

test('ics export has recurrence', () => {
  const ics = C.buildICS([{ id: 'a', type: 'subscription', title: 'Canva', due: '2026-11-01T09:00', repeat: { freq: 'month', n: 1 }, amount: 1299, currency: 'PHP' }]);
  assert.match(ics, /RRULE:FREQ=MONTHLY/);
  assert.match(ics, /BEGIN:VALARM/);
});
