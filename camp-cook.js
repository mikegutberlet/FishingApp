// Fish care and camp cooking: keeping what you keep good from the water to the pan, offline. Plain advice for
// trout, bass, panfish, catfish and kokanee; how often to eat them comes from each water's own advisory (the
// Regs & safety tab), never from here.
import { forLake } from './states/index.js';

export const CARE = [
  { title: 'Right after you land it', icon: '🩸', steps: [
    'Decide fast: release it or keep it. A fish you keep should be dispatched right away with a sharp knock on top of the head, just behind the eyes.',
    'Bleed it: cut through the gills (or the throat latch under the gill plates) and put it head-down in a bucket of lake water for a minute or two. Bled fish taste cleaner and keep longer.',
    'Keep it cold from then on. A stringer or live well in warm summer water spoils fish within hours; trout especially.',
  ] },
  { title: 'On ice', icon: '🧊', steps: [
    'Best: an ice slurry (ice plus a little lake water) in the cooler. It chills a fish in minutes, much faster than dry ice cubes.',
    'Otherwise lay fish belly-down on ice with more ice on top and inside the body cavity, and keep the cooler in the shade.',
    'Drain the meltwater every day so fish don’t sit in it, and keep fish in their own cooler or a sealed bag, away from the drinks you open all day.',
    'Below 40°F, cleaned fish keep about 2 days. For a longer trip, eat the early catch first.',
  ] },
  { title: 'Cleaning at camp', icon: '🔪', steps: [
    'Clean fish well away from your site and the water’s edge, and pack the guts out (or use the fish-cleaning station or trash the campground provides). Guts left on the bank draw bears, raccoons and flies.',
    'Trout and kokanee: slit the belly from vent to gills, pull the gills and guts out together, then run a thumbnail along the backbone to clear the dark bloodline.',
    'Bass, crappie and catfish: fillet them. Skin catfish and bass if you dislike a strong taste, and cut out the dark red strip along the lateral line.',
    'Rules first: where a size or bag limit applies, many waters require fish to stay identifiable (whole, or with skin left on the fillets) until you are home or cooking them. Check the water’s regulations on the Regs & safety tab before you fillet.',
  ] },
  { title: 'Keeping it safe to eat', icon: '🌡️', steps: [
    'Cook fish until it flakes and is opaque all the way through: 145°F in the thickest part.',
    'Wash your hands, knife and board in treated water after handling raw fish, before anything else.',
    'Skinless fillets with the belly fat and dark meat cut off carry less of the mercury and PCBs that advisories warn about.',
  ] },
];

export const COOK = [
  { title: 'Trout in foil over coals', icon: '🔥', for: 'Trout, kokanee', steps: [
    'Cleaned whole fish on a sheet of heavy foil. Inside: butter, lemon slices, garlic, salt and pepper, and a sprig of dill or a few onion rings.',
    'Seal the foil tight and lay it on coals (not flames) or a grill: about 6–8 minutes a side for a 12-inch trout.',
    'Done when the meat lifts off the backbone. The skin peels away in one piece.',
  ] },
  { title: 'Pan-fried trout', icon: '🍳', for: 'Trout, kokanee, panfish', steps: [
    'Dry the fish, dust it in seasoned flour or cornmeal.',
    'Hot skillet, a good layer of oil plus a knob of butter. Fry 3–4 minutes a side until golden and it flakes.',
    'Breakfast trick: fry bacon first and cook the trout in the fat.',
  ] },
  { title: 'Fish tacos', icon: '🌮', for: 'Bass, crappie, catfish fillets', steps: [
    'Cut fillets into strips, season with chili powder, cumin, salt and lime.',
    'Fry in a hot skillet 2–3 minutes a side, or batter and shallow-fry.',
    'Warm tortillas, shredded cabbage, salsa and a squeeze of lime. Easy for a crowd.',
  ] },
  { title: 'Blackened catfish', icon: '🌶️', for: 'Catfish, bass', steps: [
    'Coat fillets in melted butter, then a heavy layer of paprika, garlic powder, cayenne, thyme and salt.',
    'Very hot cast iron, outside or over the fire (it smokes): about 2–3 minutes a side.',
  ] },
  { title: 'Leftover fish', icon: '🥔', for: 'Any', steps: [
    'Flake cooked fish into the next morning’s hash browns and eggs, or mix with mayo, mustard and relish on crackers.',
    'Cooked fish keeps a day in a cold cooler; eat it next and don’t re-warm it twice.',
  ] },
];

// How often to eat fish from this water: the site advisory if the water has one, or the statewide advice. A short
// line for the camp trip, with the advisory's servings for the species you kept when it lists them.
export async function eatLine(lake, species = []) {
  const S = forLake(lake);
  const eat = await S?.fishAdviceFor?.(lake).catch(() => null);
  if (!eat) return null;
  const list = eat.site?.length ? eat.site : eat.statewide ? [eat.statewide] : [];
  const rows = list.flatMap(a => Array.isArray(a.fish) ? a.fish : []).filter(Array.isArray);
  const lc = s => String(s ?? '').toLowerCase();
  const match = species.map(sp => rows.find(r => lc(r[0]).includes(lc(sp).split(' ').at(-1)) && lc(r[0]).includes(lc(sp).split(' ')[0])) ?? rows.find(r => lc(r[0]).includes(lc(sp).split(' ').at(-1)))).filter(Boolean);
  return { site: !!eat.site?.length, name: list[0]?.name ?? null, match: [...new Set(match)], url: eat.url ?? list[0]?.url ?? null };
}
