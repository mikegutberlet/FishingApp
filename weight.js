// Length → weight estimates from published standard-weight (Ws) equations: log10(W g) = a + b·log10(L mm), total length.
// Ws describes a well-fed fish (about the 75th percentile), so treat the result as a ballpark, not a scale reading.
const WS = [
  [/largemouth/, -5.528, 3.273],      // Wege & Anderson 1978
  [/smallmouth/, -5.329, 3.200],      // Kolander et al. 1993
  [/spotted bass/, -5.392, 3.215],    // Wiens et al. 1996
  [/striped bass|striper/, -4.924, 2.997], // Brown & Murphy 1991
  [/white bass/, -5.066, 3.081],      // Brown & Murphy 1991
  [/bluegill/, -5.374, 3.316],        // Hillman 1982
  [/redear/, -4.968, 3.119],          // Pope et al. 1995
  [/green sunfish/, -4.915, 3.105],   // Hyatt 2004
  [/black crappie/, -5.618, 3.345],   // Neumann & Murphy 1991
  [/white crappie|crappie/, -5.642, 3.332],
  [/yellow perch|perch/, -5.386, 3.230], // Willis et al. 1991
  [/walleye/, -5.453, 3.180],         // Murphy et al. 1990
  [/northern pike|pike/, -5.437, 3.096], // Willis 1989
  [/muskellunge|musky|muskie/, -5.991, 3.271],
  [/rainbow|steelhead/, -4.898, 2.990], // Simpkins & Hubert 1996 (lentic)
  [/brown trout/, -5.422, 3.194],     // Hyatt & Hubert 2001 (lentic)
  [/brook trout/, -5.186, 3.103],     // Hyatt & Hubert 2000
  [/lake trout|mackinaw/, -5.681, 3.246], // Piccolo et al. 1993
  [/cutthroat/, -5.192, 3.086],       // Kruse & Hubert 1997
  [/kokanee|salmon/, -5.062, 3.034],
  [/channel catfish/, -5.800, 3.294], // Brown et al. 1995
  [/flathead/, -5.542, 3.230],        // Bister et al. 2000
  [/blue catfish/, -5.629, 3.217],
  [/carp/, -4.639, 2.920],            // Bister et al. 2000
];

// Estimated weight in pounds for a length in inches, or null when the species has no equation.
export function estimateWeight(species, lengthIn) {
  if (!lengthIn || !species) return null;
  const row = WS.find(([re]) => re.test(species.toLowerCase()));
  if (!row) return null;
  const grams = 10 ** (row[1] + row[2] * Math.log10(lengthIn * 25.4));
  return +(grams / 453.592).toFixed(2);
}
