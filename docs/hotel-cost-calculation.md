# Roteiros Europa — Hotel Cost Calculation

This document explains exactly how the platform calculates the **"Total to pay hotel"** amount shown under each hotel in an order. Use it to verify the numbers against your own manual calculation.

---

## 1. Room cost

```
Room cost per night = (DBL rooms × DBL price) + (SNGL rooms × SNGL price)
                     + (TWN rooms × TWN price) + (TRPL rooms × TRPL price)

Room cost = Room cost per night × Nights
```

---

## 2. City tax (only if "Charged separately")

If city tax is set to **"Included in room price"**, this step is skipped entirely (City tax = 0).

If "Charged separately", depending on the selected basis:

- **Per person / night**:
  ```
  Total pax = (DBL×2) + (SNGL×1) + (TWN×2) + (TRPL×3)
  City tax  = tax amount × Total pax × Nights
  ```
- **Per room / night**:
  ```
  Total rooms = DBL + SNGL + TWN + TRPL
  City tax    = tax amount × Total rooms × Nights
  ```
- **% of room price**:
  ```
  City tax = Room cost × (tax % / 100)
  ```

---

## 3. Hotel FOC discount (only if a policy is selected, e.g. "1 per 20")

```
Total pax    = (DBL×2) + (SNGL×1) + (TWN×2) + (TRPL×3)
Free persons = floor(Total pax ÷ X)        ← X = the "per X" number (e.g. 20)
```

The discount depends on what room type the free person occupies ("FOC person occupies"):

| FOC person occupies | Share of room price that's free per free person |
|---|---|
| SNGL | 100% of SNGL price |
| DBL  | 50% of DBL price |
| TWN  | 50% of TWN price |
| TRPL | 33.3% of TRPL price |

```
Per-person price = Room price of that type ÷ occupancy (SNGL=1, DBL=2, TWN=2, TRPL=3)
FOC discount      = Free persons × Per-person price × Nights
```

If "No FOC" is selected, this step is skipped (FOC discount = 0).

---

## 4. Final total

```
Total to pay hotel = Room cost + City tax − FOC discount
```

---

## 4. Meals (dinners / lunches)

```
Total pax for meals = (DBL×2) + (SNGL×1) + (TWN×2) + (TRPL×3)

Dinner cost = Dinners (nights) × Dinner price/person × Total pax
Lunch cost  = Lunches (days)   × Lunch price/person  × Total pax
```

---

## 5. Guide accommodation

The guide always stays the **full hotel period** (same as the group):

```
Guide cost = Guide room price/night × Nights   (only if a guide room type is selected)
```

---

## 6. Driver accommodation

The driver may stay only **part of the period** (e.g. only the last night before an early departure):

```
Driver nights = "Driver nights" field if filled, otherwise = Nights (full stay)
Driver cost   = Driver room price/night × Driver nights   (only if accommodation ≠ "Goes home")
```

---

## 7. Final total

```
Total to pay hotel = Room cost + City tax + Dinner cost + Lunch cost
                    + Guide cost + Driver cost − FOC discount
```

---

## Worked example

Say a hotel has:
- 10 DBL rooms @ 150 EUR/night
- 1 SNGL room @ 120 EUR/night
- 3 nights
- City tax: 4.20 EUR/person/night, charged separately
- Hotel FOC: "1 per 20", FOC person occupies DBL
- 2 dinners @ 28 EUR/person
- Guide: SNGL room @ 100 EUR/night
- Driver: same hotel @ 90 EUR/night, only 1 night (driverNights = 1)

**Step 1 — Room cost**
```
Room cost per night = (10 × 150) + (1 × 120) = 1500 + 120 = 1620
Room cost = 1620 × 3 = 4860 EUR
```

**Step 2 — City tax**
```
Total pax = (10×2) + (1×1) = 21
City tax = 4.20 × 21 × 3 = 264.60 EUR
```

**Step 3 — FOC discount**
```
Total pax = 21
Free persons = floor(21 ÷ 20) = 1
DBL price ÷ 2 = 150 ÷ 2 = 75 EUR/person/night
FOC discount = 1 × 75 × 3 = 225 EUR
```

**Step 4 — Meals**
```
Dinner cost = 2 × 28 × 21 = 1176 EUR
```

**Step 5 — Guide**
```
Guide cost = 100 × 3 = 300 EUR
```

**Step 6 — Driver**
```
Driver cost = 90 × 1 = 90 EUR
```

**Step 7 — Total**
```
Total = 4860 + 264.60 + 1176 + 300 + 90 − 225 = 6465.60 EUR
```

---

## Notes / known limitations

- The **city tax basis (per person / per room / %)** and **"included vs separate"** setting are taken from what you entered for that specific hotel — double check these are correct for the country, as rules vary widely across Europe.
- The Hotel FOC discount is **automatic** based on total room occupancy (pax), not on the order's overall pax count — if the hotel's FOC policy is based on a different pax count (e.g. only paying clients, excluding guide/driver), you may need to adjust manually.
- Meal counts (dinners/lunches) apply to **everyone staying at this hotel** (rooms-derived pax). If the guide/driver don't eat with the group, or only some pax do, adjust the count/price accordingly as a workaround.
