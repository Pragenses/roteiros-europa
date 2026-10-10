// Hotelové alternativy – společná pravidla pro nabídku, Dashboard a seznamy.
//
// Alternativa = hotel, který se klientovi nabízí jako další možnost.
// Na kartě má zaškrtnuté „Alternativa“ (isAlt) a vybraný hlavní hotel
// (altOf = id hlavního hotelu). Do hlavní ceny se NEpočítá (enabled === false).

export const isHotelItem = (it) => !!it && it.type === 'per_pax' && it.subType === 'hotel';

// Hlavní hotel, ke kterému alternativa patří – jen pokud v nabídce pořád je,
// je zaškrtnutý do kalkulace a není zrušený. Jinak null.
export const altMainOf = (it, items) => {
  if (!isHotelItem(it) || it.enabled !== false || !it.isAlt || !it.altOf) return null;
  return (items || []).find(x =>
    String(x.id) === String(it.altOf) && isHotelItem(x) && x.enabled !== false && !x.cancelled) || null;
};

// Platná (vědomě nabídnutá) alternativa.
export const isOfferedAlt = (it, items) => !!altMainOf(it, items) && !it.cancelled;

// Nabídka je uzavřená: převedená na zakázku nebo odmítnutá.
export const offerIsClosed = (offer) => !!offer && (offer.status === 'won' || !!offer.declined);

// Potvrzený, nezaškrtnutý a nezrušený hotel.
export const isConfirmedStray = (it) =>
  isHotelItem(it) && it.enabled === false && !it.cancelled && it.bookingStatus === 'confirmed';

// Potvrzený hotel mimo kalkulaci, který vyžaduje akci (oranžové upozornění):
// buď to není platná alternativa, nebo je nabídka už uzavřená
// (klient vybral → alternativu je potřeba zrušit).
export const strayNeedsAction = (it, items, offer) =>
  isConfirmedStray(it) && (!isOfferedAlt(it, items) || offerIsClosed(offer));

// Hlídat opci? (schváleno 11. 10. 2026) — jen u hotelu, který není potvrzený
// ani zrušený, a je buď zaškrtnutý do kalkulace, nebo je platnou nabídnutou
// alternativou v otevřené nabídce. Odškrtnuté/nevybrané hotely se nehlídají.
export const watchOption = (it, items, offer) =>
  isHotelItem(it) && !!it.optionDate && !it.cancelled && it.bookingStatus !== 'confirmed'
  && (it.enabled !== false || (isOfferedAlt(it, items) && !offerIsClosed(offer)));

// Hlídat storno lhůtu? — zaškrtnutý nezrušený hotel, nebo potvrzený hotel mimo
// kalkulaci (ten je potřeba zrušit včas).
export const watchStorno = (it) =>
  isHotelItem(it) && !!it.cancellationDeadline && !it.cancelled
  && (it.enabled !== false || it.bookingStatus === 'confirmed');

export const hotelLabel = (it) => [it.city, it.name].filter(Boolean).join(' – ') || 'hotel bez názvu';
