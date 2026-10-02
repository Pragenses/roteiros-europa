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

export const hotelLabel = (it) => [it.city, it.name].filter(Boolean).join(' – ') || 'hotel bez názvu';
