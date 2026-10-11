// Termíny – JEDNA sada pravidel pro Dashboard, Kalendář v aplikaci
// i kalendáře v telefonu (Mac / iPhone / Google).
//
// Soubor je čistý JavaScript bez Reactu a bez Firebase, aby ho mohl používat
// i program, který vyrábí kalendáře pro telefon. Když se tady změní pravidlo,
// změní se všude najednou.
//
// Pravidla (schválila Helena 2026-10-10):
// - Storno lhůta se hlídá JEN u potvrzených hotelů (bookingStatus 'confirmed'),
//   které nejsou zrušené. Poptané, „v jednání“ ani předschválené hotely ne –
//   nejsou potvrzené, podepsané ani zaplacené.
// - Potvrzený hotel, který NENÍ zaškrtnutý do kalkulace, je „alternativa“ –
//   hlídá se i v odmítnutých a převedených nabídkách (aby se na něj nezapomnělo).
// - Potvrzený hotel bez vyplněné storno lhůty = upozornění „chybí storno lhůta“.
// - Opce: hotel, který ještě není potvrzený a má datum opce.
// - Úkoly: nesplněné úkoly s termínem. Úkol bez osoby patří tomu, kdo má
//   nabídku na starost (pole „Odpovědný“); když ani to není, je nepřiřazený.
// - Uzavřené nabídky – odmítnuté (declined) nebo ve stavu „Lost / declined“ –
//   se kromě alternativ nehlídají.

export const ymd = (d) => String(d || '').slice(0, 10);

export const isHotel = (it) => !!it && it.type === 'per_pax' && it.subType === 'hotel';

export const hotelText = (it) => [it.city, it.name].filter(Boolean).join(' – ') || 'hotel bez názvu';

// Hotel, jehož storno hlídáme (jen potvrzený).
export const isBookedHotel = (it) => it.bookingStatus === 'confirmed';

// Nabídka, která se už nehlídá: odmítnutá nebo ve stavu Lost.
export const isClosedOffer = (offer) => !!offer && (!!offer.declined || offer.status === 'lost');

export const offerText = (offer) => [offer.offerNumber, offer.name].filter(Boolean).join(' · ') || '(bez názvu)';

// Kdo úkol dostane: přiřazená osoba, jinak odpovědný za nabídku, jinak nikdo ('').
export const taskOwner = (task, offer) => (task && task.who) || (offer && offer.responsible) || '';

// Vrátí všechny termíny ze všech nabídek.
// kind: 'storno' | 'option' | 'missing_storno' | 'task'
// alt: true = potvrzený hotel mimo kalkulaci (alternativa)
export const collectDeadlines = (offers) => {
  const list = [];
  (offers || []).forEach(offer => {
    const declined = isClosedOffer(offer);
    const base = {
      offerId: offer.id,
      offerNumber: offer.offerNumber || '',
      offerName: offer.name || '',
      offerLabel: offerText(offer),
      clientName: offer.clientName || '',
      responsible: offer.responsible || '',
    };
    (offer.items || []).forEach(item => {
      if (!isHotel(item) || item.cancelled) return;
      const hotel = hotelText(item);
      const confirmed = isBookedHotel(item);
      const alt = item.enabled === false;
      if (confirmed) {
        // Alternativy se hlídají všude, ostatní hotely jen v otevřených nabídkách.
        if (declined && !alt) return;
        if (item.cancellationDeadline) {
          list.push({ ...base, kind: 'storno', alt, date: ymd(item.cancellationDeadline), hotel, itemId: item.id });
        } else {
          list.push({ ...base, kind: 'missing_storno', alt, date: '', hotel, itemId: item.id });
        }
        return;
      }
      if (declined) return;
      if (item.optionDate) {
        list.push({ ...base, kind: 'option', alt, date: ymd(item.optionDate), hotel, itemId: item.id });
      }
    });
    if (declined) return;
    (offer.todos || []).forEach(t => {
      if (t.done || !t.due) return;
      list.push({ ...base, kind: 'task', date: ymd(t.due), text: t.text || 'úkol',
                  who: taskOwner(t, offer), assigned: !!t.who, taskId: t.id, itemId: t.itemId || '' });
    });
  });
  return list;
};

// Počet dní od dneška (záporné = už prošlo).
export const daysFrom = (dateYmd, todayYmd) => {
  if (!dateYmd) return null;
  const a = Date.UTC(+dateYmd.slice(0, 4), +dateYmd.slice(5, 7) - 1, +dateYmd.slice(8, 10));
  const b = Date.UTC(+todayYmd.slice(0, 4), +todayYmd.slice(5, 7) - 1, +todayYmd.slice(8, 10));
  return Math.round((a - b) / 86400000);
};
