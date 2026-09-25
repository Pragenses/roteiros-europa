// Lidé v aplikaci — kdo má nabídku na starost, pro koho je připnutá, čí je pohled.
// Kódy a barvy jsou stejné jako u poznámek a úkolů v detailu nabídky.
export const PEOPLE = [
  { code: 'HD', name: 'Helena Dlasková',   short: 'Helena',    color: '#1a3a5c', bg: '#e6f1fb', email: 'helena.maria.brito@gmail.com' },
  { code: 'FD', name: 'Filip Dlask',       short: 'Filip',     color: '#7a5c0a', bg: '#f6ecd0', email: 'filipdlask@gmail.com' },
  { code: 'HŠ', name: 'Helena Škorkovská', short: 'Helena Š.', color: '#a11a1a', bg: '#fceaea', email: 'skorkovska@gmail.com' },
];

export const personByCode = (code) => PEOPLE.find(p => p.code === code) || null;

// Kód přihlášeného člověka podle jeho e-mailu, nebo '' když ho neznáme.
export const codeForEmail = (email) => {
  const e = String(email || '').toLowerCase();
  const p = PEOPLE.find(x => x.email === e);
  return p ? p.code : '';
};
