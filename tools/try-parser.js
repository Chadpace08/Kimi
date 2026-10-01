const C = require('../core.js');
const now = new Date(2026, 9, 1, 10, 30); // Thu Oct 1 2026, 10:30
const phrases = process.argv.slice(2).length ? process.argv.slice(2) : [
  "Remind me to pay my bill on October 15.",
  "My Canva subscription is 1,299 pesos monthly, remind me every month.",
  "Remind me tomorrow morning to send the invoice.",
  "I need to renew my domain in December.",
  "Remind me every Friday to check my bookkeeping.",
  "call mom",
  "remind me in 20 minutes to take out the laundry",
  "pay meralco 2,350 on the 20th",
  "Netflix 549 a month",
  "remind me at 3 to call the bank",
  "take my vitamins every morning",
  "submit BAS on October 28 at 2pm",
  "send payroll every other Friday",
  "rent is due on the 5th of every month 15000 pesos",
  "dentist appointment next Tuesday at 10:30 am",
  "Pay credit card bill on the 25th every month",
  "bukas ng umaga bayaran ang internet",
  "renew car registration in March 2027",
  "remind me tonight to charge my phone",
  "check emails every weekday at 8",
  "Spotify $11.99 monthly",
  "water the plants this weekend",
  "Remind me to pay the electricity bill 3,200 pesos on 10/20",
  "Google Workspace yearly on January 5",
  "buy a gift for Yen's birthday on December 3rd",
];
for (const p of phrases) {
  const r = C.parse(p, { now, currency: 'PHP' });
  console.log(JSON.stringify(p).padEnd(72), '→', JSON.stringify(r.title), '|', r.type, '|', C.whenLabel(r.due, now), '|', C.repeatLabel(r.repeat, r.due), '|', r.amount != null ? C.money(r.amount, r.currency) : '', r.guessed ? '(guessed)' : '');
}
