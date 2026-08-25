/**
 * The structures a recreation of Pittsburgh has to actually contain.
 *
 * `n`   dataset name to look for
 * `alt` other names the dataset may legitimately use
 * `osm` OSM `name` when it differs from ours (OSM calls the Koppers Building
 *       "Koppers Tower" and One Oxford Centre "One Oxford Center")
 * `h`   cited roof height in metres, only where a published figure exists;
 *       heights without a citation are left out so the audit falls back to the
 *       OSM `height` tag rather than comparing against a guess
 *
 * Heights are roof heights from the Wikipedia "List of tallest buildings in
 * Pittsburgh" table (which sources the PGH Skyscraper/CTBUH figures), converted
 * from the cited feet. Spires and antennae are excluded, because the dataset `h`
 * is the extrusion height of the shell.
 */
export const CHECKLIST = [
  // ---- Golden Triangle towers, tallest first ------------------------------
  { n: 'U.S. Steel Tower', alt: ['US Steel Tower'], h: 256.3 }, // 841 ft
  { n: 'BNY Mellon Center', h: 221 }, // 725 ft
  { n: 'One PPG Place', h: 193.5 }, // 635 ft to the central spire
  { n: 'Fifth Avenue Place', h: 187.8 }, // 616 ft
  { n: 'One Oxford Centre', osm: 'One Oxford Center', h: 187.5 }, // 615 ft
  { n: 'Gulf Tower', h: 177.4 }, // 582 ft
  { n: 'Tower at PNC Plaza', h: 166.1 }, // 545 ft
  { n: 'K&L Gates Center', h: 156.1 }, // 512 ft
  { n: 'Grant Building', h: 147.8 }, // 485 ft
  { n: 'Koppers Building', osm: 'Koppers Tower', h: 144.8 }, // 475 ft
  { n: 'Two PNC Plaza', h: 136.2 }, // 447 ft
  { n: 'EQT Plaza', h: 132.3 }, // 434 ft
  { n: 'One PNC Plaza', h: 129.5 }, // 425 ft
  { n: 'Three PNC Plaza', h: 110 }, // 361 ft
  { n: '11 Stanwix Street', h: 108.2 }, // 355 ft
  { n: 'Frick Building', h: 100.6 }, // 330 ft
  { n: 'Union Trust Building', h: 72.2 }, // 237 ft to the roof
  { n: 'The Duquesne Club' },
  { n: 'Mellon National Bank Building' },
  { n: 'Benedum-Trees Building' },

  // ---- the rest of the PPG Place block -----------------------------------
  { n: 'Two PPG Place' },
  { n: 'Three PPG Place' },
  { n: 'Four PPG Place' },
  { n: 'Five PPG Place' },
  { n: 'Six PPG Place' },
  { n: 'PPG Place Wintergarden' },

  // ---- civic and cultural ------------------------------------------------
  { n: 'Pittsburgh City-County Building', alt: ['City-County Building'], h: 43.9 }, // 144 ft
  { n: 'Allegheny County Courthouse' }, // roof 100 ft, tower 250 ft
  { n: 'Heinz Hall for the Performing Arts', alt: ['Heinz Hall'] },
  { n: 'Benedum Center' },
  { n: 'David L. Lawrence Convention Center' },
  { n: 'Senator John Heinz History Center' },
  { n: 'The Andy Warhol Museum' },
  { n: 'Kamin Science Center', alt: ['Carnegie Science Center'] },
  { n: 'Fort Pitt Museum' },
  { n: 'Fort Pitt Block House' },
  { n: 'PNC Firstside Center' },
  { n: 'Nova Place', alt: ['Allegheny Center'] },

  // ---- venues ------------------------------------------------------------
  { n: 'PPG Paints Arena' },
  { n: 'PNC Park' },
  { n: 'Acrisure Stadium' },

  // ---- Oakland -----------------------------------------------------------
  { n: 'Cathedral of Learning', h: 163.1 }, // 535 ft
  { n: 'Heinz Memorial Chapel' },
  { n: 'Soldiers and Sailors Memorial Hall' },
  { n: 'Phipps Conservatory' },
  { n: 'Carnegie Museum of Art' },
  { n: 'Carnegie Museum of Natural History' },
  { n: 'Carnegie Library of Pittsburgh - Main (Oakland)', alt: ['Carnegie Library, Oakland'] },
  { n: 'Carnegie Music Hall' },
  { n: 'Saint Paul Cathedral Parish', alt: ['St. Paul Cathedral'] },
  { n: 'UPMC Presbyterian Hospital', alt: ['UPMC Presbyterian'] },
  { n: 'William Pitt Union' },

  // ---- North Side and South Side ----------------------------------------
  { n: 'Allegheny General Hospital' },
  { n: 'Sheraton Pittsburgh Hotel at Station Square' },
  { n: 'Station Square Parking Garage' },
  { n: 'Duquesne Lower Station' },
  { n: 'Duquesne Upper Station' },
  { n: 'Monongahela Lower Station' },
  { n: 'Monongahela Upper Station' },
];

/**
 * The two funiculars, for checking the hard-coded alignments in
 * src/landmarks.js against the station houses in the dataset.
 *
 * `run` is the HORIZONTAL run, not the track length: src/landmarks.js stores
 * `lower` and `upper` as x/z points and the distance between them is a plan
 * distance, so comparing it against the operators' published slope length
 * charges the model 20% of error it does not have. Derived from the published
 * track length and rise, which for these grades is the same as length x cos(grade).
 */
export const INCLINE_STATIONS = {
  'Duquesne Incline': {
    run: 208.4, // 793.7 ft of track rising 400 ft, so 684 ft of plan run
    lower: 'Duquesne Lower Station',
    upper: 'Duquesne Upper Station',
  },
  'Monongahela Incline': {
    run: 157.6, // 635 ft of track rising 369.39 ft, so 517 ft of plan run
    lower: 'Monongahela Lower Station',
    upper: 'Monongahela Upper Station',
  },
};

/**
 * Named river crossings, with the published main span for scale.
 *
 * `mainSpan` is one span of the structure, not the length of deck the dataset
 * stores. Those are different quantities and conflating them is misleading in
 * both directions: the Liberty Bridge is 812 m end to end but only 273 m of that
 * is its two cantilever river spans, while the West End Bridge's 236 m arch sits
 * inside a 468 m structure that crosses a 322 m channel. The audit measures the
 * channel from the real alignment and the water polygons instead.
 */
export const RIVER_BRIDGES = [
  { n: 'Fort Pitt Bridge', mainSpan: 368, river: 'Monongahela' },
  { n: 'Fort Duquesne Bridge', mainSpan: 445, river: 'Allegheny' },
  { n: 'Smithfield Street Bridge', mainSpan: 360, river: 'Monongahela' },
  { n: 'Liberty Bridge', mainSpan: 273, river: 'Monongahela' },
  { n: 'Roberto Clemente Bridge', mainSpan: 303, river: 'Allegheny' },
  { n: 'Andy Warhol Bridge', mainSpan: 323, river: 'Allegheny' },
  { n: 'Rachel Carson Bridge', mainSpan: 303, river: 'Allegheny' },
  { n: 'Veterans Bridge', mainSpan: 300, river: 'Allegheny' },
  { n: 'David McCullough Bridge', alt: ['16th Street Bridge'], mainSpan: 275, river: 'Allegheny' },
  { n: '31st Street Bridge', mainSpan: 265, river: 'Allegheny' },
  { n: '40th Street Bridge', alt: ['Washington Crossing Bridge'], mainSpan: 335, river: 'Allegheny' },
  { n: '62nd Street Bridge', alt: ['Robert D. Fleming Bridge'], mainSpan: 340, river: 'Allegheny' },
  { n: 'Highland Park Bridge', mainSpan: 480, river: 'Allegheny' },
  { n: 'West End Bridge', mainSpan: 236, river: 'Ohio' },
  { n: 'McKees Rocks Bridge', mainSpan: 460, river: 'Ohio' },
  { n: 'Birmingham Bridge', mainSpan: 300, river: 'Monongahela' },
  { n: 'Hot Metal Bridge', mainSpan: 330, river: 'Monongahela' },
  { n: 'South Tenth Street Bridge', alt: ['South 10th Street Bridge'], mainSpan: 220, river: 'Monongahela' },
  { n: 'Glenwood Bridge', mainSpan: 300, river: 'Monongahela' },
  { n: 'Homestead Grays Bridge', mainSpan: 470, river: 'Monongahela' },
  { n: 'Panhandle Bridge', mainSpan: 350, river: 'Monongahela' },
  { n: 'Fort Wayne Bridge', alt: ['Andy Warhol Rail Bridge'], mainSpan: 97, river: 'Allegheny' },
];

/**
 * Well-known street alignments to spot-check the network against. `osm` is the
 * OSM `name`; several carry a route number as the name in places, so the audit
 * matches on name and falls back to the reference where OSM splits them.
 */
export const STREET_SPOTS = [
  { n: 'Grant Street' },
  { n: 'Liberty Avenue' },
  { n: 'Penn Avenue' },
  { n: 'Forbes Avenue' },
  { n: 'Fifth Avenue' },
  { n: 'Smithfield Street' },
  { n: 'Wood Street' },
  { n: 'Stanwix Street' },
  { n: 'Boulevard of the Allies' },
  { n: 'Bigelow Boulevard' },
  { n: 'East Carson Street' },
  { n: 'West Carson Street' },
  { n: 'Butler Street' },
  { n: 'Baum Boulevard' },
  { n: 'Centre Avenue' },
  { n: 'Craig Street', alt: ['North Craig Street', 'South Craig Street'] },
  { n: 'Negley Avenue', alt: ['North Negley Avenue', 'South Negley Avenue'] },
  { n: 'Murray Avenue' },
  { n: 'Braddock Avenue', alt: ['South Braddock Avenue', 'North Braddock Avenue'] },
  { n: 'Bloomfield Bridge' },
  { n: 'Washington Boulevard' },
  { n: 'Sixth Avenue' },
];
