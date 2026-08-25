import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01 } from './geo.js';

/**
 * Point State Park: 36 acres at the confluence, a National Historic Landmark
 * and the single most photographed place in Pittsburgh.
 *
 * Everything below that carries a `way/` or `node/` id was read out of
 * OpenStreetMap through scripts/osm.mjs and projected with the same calibrated
 * equirectangular frame the shipped dataset uses, so it lands on top of the
 * city's own buildings, streets and water. The park outline itself arrives as
 * `pointPark.f` (OSM way 387635995) and is not duplicated here.
 *
 * The Fort Pitt Museum (way 109499955) and the Fort Pitt Block House
 * (way 109499956) are ordinary OSM buildings in the dataset, so the normal
 * building pass draws them and they are deliberately absent from this file.
 */

/* ------------------------------------------------------------------ */
/* survey data                                                         */
/* ------------------------------------------------------------------ */

/**
 * The fountain basin, OSM way 1037461399 (`amenity=fountain`, "Point State
 * Park Fountain"). The traced ring is a 55.3 m circle centred 44 m back from
 * the confluence tip; the granite rim and apron carry the whole work out to
 * the 200 ft diameter the park literature quotes.
 */
const FOUNTAIN = [-913.6, -92.3];
const BASIN_R = 27.6;

/**
 * Lawns, from the `landuse=grass` polygons inside the park. The first is the
 * Great Lawn (way 313640880); the second and third are the City Side Lawn and
 * its apron east of the highway. Simplified to 2.2 m.
 */
const GRASS = [
  [
    [-665.8, -82.5], [-669.4, -98.8], [-689.5, -100.1], [-715.5, -115.6], [-741.5, -124.4], [-757.2, -125.6],
    [-794.3, -113.9], [-833.5, -124.8], [-853.5, -119.5], [-851.7, -83.1], [-865.2, -47.6], [-848.2, -36.4],
    [-823.5, -34.3], [-780.8, -10.4], [-757, -9.3], [-718.1, -27.4], [-697.1, -32.9], [-684.3, -33.4],
    [-675.2, -27.2], [-666.6, -53.6],
  ],
  [
    [-495.3, -138.7], [-515.9, -125], [-531.1, -105.7], [-541.5, -80.9], [-548.9, -38.6], [-547.9, -27.6],
    [-539.8, -13.4], [-525.8, -4.3], [-506.4, 0.1], [-477.8, -1.7], [-460, -7.4], [-441.3, -18.2],
    [-435.5, -31.1], [-438.2, -42.5], [-454.9, -71.7], [-463.5, -124.9], [-477.1, -136.1],
  ],
  [
    [-576.9, 76.3], [-488.8, 25.1], [-420.2, -6.2], [-427.2, -13.5], [-434.1, -14.2], [-470.7, 3.5],
    [-490.7, 7.2], [-529.9, 7.1], [-531.4, 11.9], [-541.6, 8.4], [-539.9, 3.4], [-548.2, -5.9],
    [-552.9, -25], [-568.5, -27.8], [-580.2, 63.9],
  ],
  [
    [-543.3, 84.2], [-535, 101.9], [-460.3, 115.3], [-453.5, 112], [-438.6, 79.6], [-459, 70.6],
    [-486.6, 68.1], [-514.8, 72.2],
  ],
  [
    [-635.7, -5.9], [-645.2, -8.5], [-671.4, -1], [-689.3, 11.7], [-699.1, 24.8], [-704.6, 43],
    [-703.5, 59.6], [-696.7, 74.9], [-686, 83.5], [-676.5, 86.3], [-663.2, 83.5], [-648.7, 70.2],
    [-647.3, 67.2], [-681.7, 49.6], [-660, 17.1], [-645.8, 18.1],
  ],
  [
    [-563.5, -70.9], [-550.6, -70.5], [-540.1, -101.1], [-522.1, -126.6], [-497.1, -144.5], [-465.3, -152.9],
    [-467.2, -161.6], [-480.6, -163.7], [-499.5, -150], [-515.1, -144.5], [-546.4, -148.1], [-557.5, -119.1],
  ],
  [
    [-419.7, 19.3], [-419.9, 2.1], [-438.6, 9.9], [-499.2, 39.5], [-574.9, 86], [-572.6, 89.5],
    [-502.8, 54.2],
  ],
  [
    [-540.6, -156.3], [-523.6, -151.7], [-507.5, -154.7], [-465.4, -186], [-452.4, -201.1], [-505.7, -182.3],
    [-528.6, -168.9],
  ],
  [
    [-495.5, 59.7], [-464.1, 61.7], [-433.8, 70.9], [-419.9, 43.3], [-417.3, 27.2],
  ],
  [
    [-518.7, -208], [-542.9, -187.3], [-552.4, -167.1], [-547.4, -161.9], [-519.8, -184.2], [-459.1, -206],
    [-490.4, -204.8],
  ],
  [
    [-657.4, -162.9], [-660.6, -153.3], [-659, -145.8], [-653.6, -138.9], [-642.1, -135], [-623.4, -153.5],
    [-623.6, -157.4], [-639.3, -169.7], [-648.6, -169.4],
  ],
  [
    [-556.9, 96.3], [-552.6, 106.2], [-561.8, 123.8], [-574.8, 109.4], [-573.1, 105.9], [-580.9, 101.8],
    [-587.1, 111], [-559.3, 142.3], [-540.5, 107.1], [-548.2, 91.9],
  ],
  [
    [-548.3, -217.3], [-556.7, -211.8], [-563.1, -200.2], [-563.5, -186.7], [-559, -173.1], [-547.1, -193.4],
    [-528.9, -210.5],
  ],
  [
    [-661.5, -44], [-670.1, -26.7], [-663.1, -29.8], [-653.6, -25.8], [-659.3, -11.8], [-653.1, -13.3],
    [-649, -22.8], [-638.9, -21.2], [-633.1, -34], [-644.6, -46.6],
  ],
  [
    [-418.9, -24.6], [-427.4, -27.7], [-433.8, -53.2], [-431.4, -61.1],
  ],
  [
    [-548.2, 91.9], [-544.5, 90.1], [-538, 103.2], [-540.5, 107.1],
  ],
];

/**
 * The woodlands, from the `natural=wood` polygons (ways 379511873/874/877/879/
 * 885/886/891/892/897). Griswold and Stotz planted these belts entirely with
 * Western Pennsylvania natives; the 2008 restoration put them back. They flank
 * the Great Lawn north and south and total 1.7 ha.
 */
const WOODS = [
  [
    [-848.2, -36.4], [-854.6, -25.5], [-816.6, -1.7], [-784, 11], [-735.5, 19.8], [-716.6, 16.4],
    [-703.2, 9], [-683.6, -11.2], [-675.2, -27.2], [-684.3, -33.4], [-692, -33.9], [-718.1, -27.4],
    [-747.1, -12.4], [-772.7, -8.4], [-785.2, -12.2], [-823.5, -34.3],
  ],
  [
    [-669.4, -98.8], [-677.2, -120], [-691.3, -137], [-706.7, -146.3], [-722.3, -150.8], [-779.9, -151.9],
    [-836.8, -138], [-833.5, -124.8], [-799.1, -114.3], [-786.9, -114.8], [-765.1, -123.9], [-750.4, -125.8],
    [-720.5, -117.9], [-689.5, -100.1],
  ],
  [
    [-627.4, -86.2], [-623.7, -85], [-624.3, -93], [-639.1, -113.4], [-643.6, -132.7], [-660.4, -137.6],
    [-667.4, -147.2], [-666.7, -160.3], [-655.8, -173.7], [-659.8, -181.7], [-664.3, -181.7], [-673.9, -171.9],
    [-680.7, -156.7], [-678.5, -132.1], [-663.9, -116], [-630.5, -93.5],
  ],
  [
    [-588, -204.2], [-600.7, -201.8], [-616.5, -155], [-631.9, -139.3], [-636.7, -128.7], [-636.5, -118.7],
    [-622.1, -97.2], [-619.5, -83.4], [-614, -82], [-609.9, -162.2], [-603.2, -182.6],
  ],
  [
    [-754.2, -158.7], [-714.8, -154.3], [-686.1, -139.4], [-684.7, -161.1], [-672.8, -182.7], [-754.8, -161.1],
  ],
  [
    [-718, 25.8], [-722.2, 22.5], [-745.2, 23.9], [-795.2, 13.5], [-745, 47.2], [-733.2, 46.1],
    [-724.9, 40.7],
  ],
  [
    [-666.3, -107.2], [-659, -75.8], [-637.6, -68.7], [-633.1, -90], [-663.3, -110.1],
  ],
  [
    [-650.7, -175.9], [-632.1, -174.9], [-620.4, -156.4], [-607.4, -201.9], [-623, -189.7], [-651.8, -187.7],
    [-654, -184.4],
  ],
  [
    [-588, -187.3], [-596.6, -171.7], [-602.1, -146.4], [-603.5, -115.1], [-599.3, -95.2], [-590.2, -149.3],
  ],
];

/**
 * Walk and promenade centrelines, from the `highway=footway|path|cycleway|
 * pedestrian` ways whose nodes fall inside the park. `w` is the paved width:
 * 4.6 m for the shared-use riverfront promenades that carry the Three Rivers
 * Heritage Trail, 2.6 m for the garden walks.
 */
const PATHS = [
  { w: 4.6, c: [
    [-550.6, -56.3], [-540.4, -93.1], [-526.9, -116.6], [-517.3, -127.5], [-501.6, -139],
    [-483.9, -142.8], [-464.3, -133.8], [-458.1, -122.7], [-454.7, -93.7], [-445.8, -63.9],
    [-433.2, -41], [-433, -27.4], [-440.3, -14.4], [-468.1, -0.7], [-489.1, 3.3],
    [-518.1, 0.9], [-534.6, -5], [-547.3, -18.2], [-551.8, -31.2], [-550.6, -56.3],
  ] },
  { w: 4.6, c: [
    [-952.5, -98.9], [-950.1, -76.4], [-942.6, -64.6], [-935.2, -58.6], [-728.5, 79],
    [-687.3, 104.9], [-635.1, 111.3],
  ] },
  { w: 4.6, c: [
    [-670.9, -116.8], [-631.1, -89.6], [-626.4, -55.3], [-628.9, -31.1], [-635.6, -18.2],
    [-680.1, -1.2], [-709.1, 17.5], [-726.3, 21.2], [-748.2, 20.9], [-810.9, 7.3],
  ] },
  { w: 4.6, c: [
    [-839.7, -139.6], [-653, -190.7], [-624.8, -191.4], [-617.2, -196], [-612.4, -203.1],
    [-611.3, -217.9],
  ] },
  { w: 4.6, c: [
    [-786.6, -168.4], [-930.7, -128.5], [-947.5, -113.4], [-952.5, -98.9],
  ] },
  { w: 4.6, c: [
    [-782.7, -155.1], [-723.3, -152.9], [-700.3, -146], [-686, -136.2], [-674.7, -122.9],
    [-668.1, -107.8], [-662.4, -75.1], [-663.3, -58.9],
  ] },
  { w: 4.6, c: [
    [-786.6, -168.4], [-611.3, -217.9],
  ] },
  { w: 4.6, c: [
    [-719.3, 49.6], [-728.1, 48.9], [-741.2, 53.4], [-857.8, -23.9],
  ] },
  { w: 4.6, c: [
    [-857.8, -23.9], [-881.1, -39.4], [-867.8, -60.5], [-860.8, -84.6], [-860.7, -107.4],
    [-865.8, -132.1], [-839.7, -139.6],
  ] },
  { w: 2.6, c: [
    [-647.3, 67.2], [-679.8, 49.6], [-659.8, 18.1], [-645.2, 19], [-630.6, -16],
    [-633.2, -20.8],
  ] },
  { w: 4.6, c: [
    [-663.3, -58.9], [-669.2, -36.1], [-678.1, -16.2], [-719.3, 49.6],
  ] },
  { w: 4.6, c: [
    [-618.7, -54.5], [-623, -94.8], [-636.6, -113.8], [-639.5, -125.1], [-633.8, -141],
    [-620.5, -152], [-616.5, -161.7],
  ] },
  { w: 4.6, c: [
    [-620.5, -152], [-627.6, -168.2], [-639.4, -175.5], [-649.4, -175.2], [-661.8, -166.5],
    [-666, -155.2], [-663.5, -143], [-658.3, -138.9], [-646, -135.9], [-638.9, -129.7],
  ] },
  { w: 4.6, c: [
    [-719.3, 49.6], [-710.3, 55.6], [-702.9, 72.5], [-695.2, 83.1], [-683.1, 89.7],
    [-668, 91.1], [-635.1, 111.3],
  ] },
  { w: 4.6, c: [
    [-631.7, 53.7], [-622.8, 4.9], [-618.7, -54.5],
  ] },
  { w: 2.6, c: [
    [-765.1, -123.9], [-741.5, -124.4], [-715.5, -115.6], [-689.5, -100.1], [-677.3, -97.9],
    [-666.1, -99.8],
  ] },
  { w: 2.6, c: [
    [-772.7, -8.4], [-747.1, -12.4], [-718.1, -27.4], [-692, -33.9], [-684.3, -33.4],
    [-675.2, -27.2],
  ] },
  { w: 4.6, c: [
    [-695.2, 83.1], [-702.2, 80.1], [-712.5, 67.2], [-706.5, 83.9], [-699.9, 92.6],
    [-676.6, 105.9],
  ] },
  { w: 2.6, c: [
    [-890.4, -52.6], [-877.7, -77.2], [-875.4, -86.6], [-878, -121.5],
  ] },
  { w: 4.6, c: [
    [-659.2, -189.1], [-672.1, -178.9], [-682.2, -160.9], [-683.8, -150.8], [-681.2, -131.2],
  ] },
  { w: 5.5, c: [
    [-572.9, 100.7], [-574.4, 104], [-570.3, 106.4], [-572, 108.9], [-562, 119.2],
    [-555.3, 106.9], [-560.3, 95.6], [-572.9, 100.7],
  ] },
  { w: 2.6, c: [
    [-612.6, 65.1], [-638.2, 66.5], [-664.3, 93.4],
  ] },
  { w: 2.6, c: [
    [-873.9, -19.2], [-872.1, -22.2], [-862.9, -16.4], [-861.9, -17.8], [-886.3, -34.2],
    [-881.1, -39.4],
  ] },
  { w: 2.6, c: [
    [-659.6, -13.1], [-654.7, -25.3], [-662.9, -29], [-670.6, -25.4], [-668.4, -16.9],
    [-659.6, -13.1],
  ] },
  { w: 2.6, c: [
    [-614.5, -171], [-602.9, -201.8], [-599, -205.7], [-592.4, -206.1],
  ] },
  { w: 4.6, c: [
    [-618.7, -54.5], [-663.3, -58.9],
  ] },
  { w: 2.6, c: [
    [-862.2, -117.9], [-836, -125], [-839.7, -139.6],
  ] },
  { w: 2.6, c: [
    [-872.8, -51.8], [-850.2, -36.5], [-857.8, -23.9],
  ] },
  { w: 2.6, c: [
    [-659.6, -13.1], [-676.3, -9], [-669.9, -22.9],
  ] },
];

/**
 * The three granite traceries, laid flush in the turf and the paving:
 *   way 109499957  Fort Duquesne Tracery, the French fort's bastioned square
 *   way 379307979  Rivers Edge Tracery, the 1754 shoreline before the fill
 *   way 379308765  Fort Pitt Tracery, the Music Bastion on the city side
 */
const TRACERIES = [
  [
    [-743.7, -76.1], [-739.3, -69.2], [-734.4, -71.8], [-725.7, -63.3], [-737.6, -59.4],
    [-740.7, -63], [-757.8, -52.1], [-755.8, -47.1], [-763.8, -37.9], [-767.8, -49.4],
    [-764, -53.4], [-775.5, -70.5], [-779.8, -68.3], [-789.5, -77.1], [-777.7, -81.1],
    [-774.1, -76.7], [-757.2, -88.4], [-759.1, -92.9], [-751, -102.6], [-747.1, -90.6],
    [-751.1, -86.9], [-743.7, -76.1],
  ],
  [
    [-772.7, -8.4], [-778.7, -15.5], [-786.1, -41.8], [-793.1, -53.4], [-803.3, -61.1],
    [-829.7, -73.7], [-834, -77.5], [-835.4, -83.5], [-831.7, -88.2], [-826.5, -90.7],
    [-783.5, -107.8], [-768.7, -118.7], [-765.1, -123.9],
  ],
  [
    [-564.8, -59.7], [-533.5, -60.1], [-528.9, -75.9], [-486, -87], [-490.6, -42.6],
    [-505.2, -35.5], [-499.7, 3.6],
  ],
];

/** Individually surveyed `natural=tree` nodes standing inside the park. */
const TREES = [
  [-820, 5.2], [-844.1, -142.1], [-792.4, -156.3], [-692.7, 77.9], [-774.2, 35.7], [-432.8, 43.4], [-789.2, 25.7],
  [-704.5, -180.6], [-666, 98.7], [-868.7, -46.6], [-653.3, 73.7], [-681.1, 94.5], [-872.8, -40], [-804.8, 15.3],
  [-447.9, 47.2], [-858.7, -129], [-721.7, -175.8], [-696.9, 87.8], [-637.8, -194.9], [-650.9, -195], [-826.5, -146.9],
  [-877.9, -33.4], [-863.7, -23.9], [-743.9, 55.9], [-809.4, -151.7], [-678.6, 84], [-856.9, -121.2], [-759.4, 45.6],
  [-686.8, -185.5], [-669.2, -190.3], [-641.3, -34.1], [-757.2, -166.1], [-834.7, -4.6], [-740, -170.8], [-849.1, -14.2],
  [-774.5, -161.3], [-434, 54.5], [-624.4, -195.9], [-446.3, 56.8], [-655.4, -36.6], [-860.8, -137.5], [-662.6, 80.9],
  [-494.7, 81.4], [-529.1, 85], [-467, 103.9], [-477, 81.8], [-514.8, 87.5], [-477.4, 93.1], [-457.5, 85.1],
  [-502.3, 104], [-525, 94.7], [-503.2, 91.7], [-478.7, 104.3], [-452.4, -99.1], [-846.6, -54.5], [-560.8, -16.8],
  [-554.7, -114.9], [-558.2, -76.6], [-570.5, 51.6], [-661.9, -147.7], [-502, 17.5], [-532.1, -191.4], [-534.2, -141.7],
  [-782.8, -105.7], [-550.1, 45.5], [-456.3, -113], [-551.9, 53.4], [-486.4, 19.1], [-821.7, -111.8], [-539, -132.9],
  [-561.2, 45.1], [-526.8, 17.1], [-435.8, -4.6], [-547.6, -130.5], [-451.5, 3.8], [-555.6, -193.7], [-557.9, 56],
  [-640.9, -135.9], [-433.7, -41.6], [-839.2, -104.9], [-792, -30.4], [-473.7, 13.6], [-443.3, -69.9], [-828.3, -46],
  [-438.1, -56.1], [-631.9, -167.9], [-549.7, 12.7], [-551.4, -123.2], [-654, -168.5], [-495.9, -180.6], [-528.8, 40.9],
  [-553.7, -102.2], [-519.7, 12.7], [-526.1, 35.9], [-732.2, -118.8], [-845, -44], [-530.5, -159.3], [-643.7, -172.1],
  [-447.5, -84.3], [-562.4, -1.6], [-781.9, -17.3], [-516.3, -140.9], [-656.2, -139.5], [-821.8, -35.7], [-554.7, -205.2],
  [-543.3, -141.8], [-514.9, 27.7], [-547.6, 34.9], [-537.5, 41], [-445.8, -1.1], [-515.4, -193], [-661.5, -159.3],
  [-526.2, -137.4], [-558, -86.7], [-467.5, 7.3], [-502.8, -176.7], [-668.9, -90.5], [-743.5, -117.5], [-551.3, 3],
  [-517.5, -160], [-837, -116.2], [-559.7, 8.6], [-705, -97.5], [-542.8, -174.6], [-483.2, -157.1],
];

/** `highway=steps` runs inside the park; only the ones that actually cross a
 *  level change get a flight built on them. */
const STEPS = [
  [[-659.2, -189.1], [-653.1, -173.5]],
  [[-786.6, -168.4], [-784.6, -161.5]],
  [[-719.3, 49.6], [-728.5, 79]],
  [[-810.9, 7.3], [-818.6, 18.5]],
  [[-872.4, -63.1], [-877, -65.6]],
  [[-865.3, -85.2], [-870.5, -85.8]],
  [[-864.3, -106.9], [-871.1, -105.7]],
  [[-661.2, -195.7], [-663.4, -202.8]],
  [[-614.5, -171], [-611.3, -180]],
];

/**
 * Inland edge of the fountain terrace, from the promenade way 349279587 that
 * runs along it, extended at both ends to meet the riverfront walk. Three
 * nine-riser flights in STEPS cross it, which puts the terrace 1.5 m below the
 * Great Lawn.
 */
const PLAZA_EDGE = [
  [-871.1, 5.7], [-857.8, -23.9], [-881.1, -39.4], [-867.8, -60.5], [-860.8, -84.6],
  [-860.7, -107.4], [-865.8, -132.1], [-873.8, -161],
];

/**
 * The Portal Bridge (way 778113555): a 1963 three-hinged reinforced concrete
 * arch by Charles and Edward Stotz with Gordon Bunshaft, threading a pedestrian
 * route under eight lanes of the Fort Pitt interchange. The span is 182 ft with
 * less than 23 ft of clearance and a deck 25 ft up; the hollow shell holds
 * three 160 ft vaults arching between four ribs at 40 ft centres. Under it lies
 * the reflecting pool, way 379511900.
 */
const PORTAL = [[-617.6, -25.7], [-568.7, -20.5], [-562.9, -77.8], [-613.7, -83.2]];
const POOL = [[-606.6, -78.2], [-569.8, -74.9], [-574.3, -26.1], [-611.1, -29.5]];

/** Fountain Pump House, way 349279596: the single-storey plant that drives the
 *  jet, standing at the head of the terrace. Not present in the dataset's
 *  building list, so it is built here. */
const PUMP_HOUSE = [[-866.1, -46.3], [-871.3, -38.5], [-857.7, -29.2], [-852.4, -37.1]];

/** node 7734716076, the 13-star flag flown beside the Block House. */
const FLAGPOLE = [-662.3, -32.5];

/**
 * The hard-surfaced areas that are not walks: the visitor car park behind the
 * Block House (way 146615172, `amenity=parking`) and the small paved court at
 * the Fort Pitt Flag Bastion (way 824681524, `highway=pedestrian area=yes`).
 * Everything else inside the boundary is turf, woodland or walk — from the air
 * the Point is a green peninsula with a pale nose, not a paved one.
 */
const PAVED = [
  [
    [-463, 119], [-496, 113], [-523, 108], [-530, 108], [-536, 111], [-540, 114], [-542, 118],
    [-561, 153], [-552, 159], [-540, 163], [-522, 168], [-504, 171], [-498, 170], [-493, 167],
    [-485, 168], [-482, 161], [-468, 135], [-465, 128],
  ],
  [
    [-572.9, 100.7], [-574.4, 104], [-570.3, 106.4], [-572, 108.9], [-562, 119.2], [-555.3, 106.9],
    [-559.2, 97.6], [-560.3, 95.6], [-571.1, 101.3],
  ],
];

/**
 * Ends of the river frontage, OSM ring vertices at the two points where the
 * park boundary leaves the water: the Monongahela wall meets Fort Pitt
 * Boulevard, and the Allegheny wall meets the Fort Duquesne Bridge ramps.
 * Every boundary vertex between them, walking forward past the tip, carries the
 * lower riverfront promenade.
 */
const RIVER_FROM = [-674.75, 120.68];
const RIVER_TO = [-496.35, -256.68];

/* Levels, all relative to the smoothed ground under the park. The peninsula is
 * made land: the deck stands clear of the terrain grid, the fountain terrace
 * steps down from it, and the riverwalks step down again inside the bulkhead. */
const DECK_LIFT = 2.2;
const WALK_DROP = 1.4;
const PLAZA_DROP = 1.1;
const FLOOR_CLEAR = 0.8;
const PROMENADE_W = 11;
const TRANSITION = 5;

/* ------------------------------------------------------------------ */
/* small geometry helpers                                              */
/* ------------------------------------------------------------------ */

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.78,
    metalness: opts.metalness ?? 0.04,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    map: opts.map ?? null,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    depthWrite: opts.depthWrite ?? true,
    side: opts.side ?? THREE.FrontSide,
    vertexColors: opts.vertexColors ?? false,
    flatShading: opts.flatShading ?? false,
  });
}

/**
 * World-aligned UVs. Every surface here is tiled against the ground plane, so
 * the texture never stretches across a draped triangle, and — just as
 * important — every geometry that reaches `mergeGeometries` carries the same
 * attribute set as the box primitives it is merged with, which is otherwise a
 * silent null return.
 */
function worldUV(geom, tile) {
  const p = geom.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = p.getX(i) / tile;
    uv[i * 2 + 1] = -p.getZ(i) / tile;
  }
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geom;
}

/**
 * Surface maps are generated here rather than taken from src/textures.js so the
 * park can carry finer tiles than the 10 m city ground: the fountain apron is
 * scored at 1.5 m and the turf clumps at well under a metre, and both are read
 * at walking distance.
 *
 * The maps carry the albedo, so the vertex colours multiplying them stay near
 * white and only supply the drift that keeps large surfaces from banding.
 */
function canvasTex(size, draw) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  draw(cv.getContext('2d'), size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Board-formed concrete, scored on a 1.5 m grid across a 6 m tile. */
function concreteTexture() {
  return canvasTex(256, (ctx, w, h) => {
    ctx.fillStyle = '#78736a';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 5000; i++) {
      const v = 112 + Math.random() * 50;
      ctx.fillStyle = `rgba(${v},${v - 3},${v - 9},${0.1 + Math.random() * 0.22})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    for (let i = 0; i < 90; i++) {
      const r = 3 + Math.random() * 9;
      ctx.fillStyle = `rgba(120,116,108,${0.05 + Math.random() * 0.07})`;
      ctx.beginPath();
      ctx.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(52,50,46,0.55)';
    ctx.lineWidth = 1.5;
    for (let k = 0; k <= 4; k++) {
      const p = (k / 4) * w;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, h);
      ctx.moveTo(0, p);
      ctx.lineTo(w, p);
      ctx.stroke();
    }
  });
}

/** Mown turf: clumped blotches plus the faint mowing bands the lawn carries. */
function turfTexture(base, blotch, band) {
  return canvasTex(256, (ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      const r = 6 + Math.random() * 26;
      ctx.fillStyle = `rgba(${blotch},${0.06 + Math.random() * 0.14})`;
      ctx.beginPath();
      ctx.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 9000; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.14})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1.6, 1.6);
    }
    if (band) {
      ctx.fillStyle = 'rgba(255,255,255,0.028)';
      for (let y = 0; y < h; y += h / 4) ctx.fillRect(0, y, w, h / 8);
    }
  });
}

function openRing(ring) {
  const n = ring.length;
  const closed = Math.hypot(ring[0][0] - ring[n - 1][0], ring[0][1] - ring[n - 1][1]) < 0.5;
  return closed ? ring.slice(0, -1) : ring.slice();
}

function ringSignedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

function pointInRing(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-12) + xi) inside = !inside;
    j = i;
  }
  return inside;
}

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth01 = (t) => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

/** Distance from a point to a segment, and the signed side it falls on. */
function segDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-9 ? clamp01(((px - ax) * dx + (pz - az) * dz) / l2) : 0;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  const d = Math.hypot(px - cx, pz - cz);
  const side = dx * (pz - az) - dz * (px - ax);
  return { d, side };
}

/**
 * True inward polygon offset with mitred joins, preserving vertex count so the
 * result still pairs 1:1 with the source ring. `metres` may be a per-edge array,
 * which is how the riverfront promenade is cut in only where the boundary is
 * actually a river wall.
 *
 * Miters are clamped because the confluence tip is acute enough to throw a
 * spike clear across the lawn.
 */
function insetRing(pts, metres) {
  const n = pts.length;
  const at = (i) => (Array.isArray(metres) ? metres[i] : metres);
  if (n < 3) return pts.map((p) => p.slice());
  const sign = ringSignedArea(pts) > 0 ? 1 : -1;

  const edges = [];
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % n];
    let dx = bx - ax;
    let dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) {
      edges.push(null);
      continue;
    }
    dx /= len;
    dz /= len;
    const m = at(i);
    edges.push({ px: ax - dz * sign * m, pz: az + dx * sign * m, dx, dz });
  }

  const prevEdge = (i) => {
    for (let k = 1; k <= n; k++) {
      const e = edges[(i - k + n * 2) % n];
      if (e) return e;
    }
    return null;
  };

  const out = [];
  for (let i = 0; i < n; i++) {
    const cur = edges[i] || prevEdge(i);
    const prev = prevEdge(i);
    if (!cur || !prev) {
      out.push(pts[i].slice());
      continue;
    }
    const cross = prev.dx * cur.dz - prev.dz * cur.dx;
    let p;
    if (Math.abs(cross) < 1e-6) {
      p = [cur.px, cur.pz];
    } else {
      const s = ((cur.px - prev.px) * cur.dz - (cur.pz - prev.pz) * cur.dx) / cross;
      p = [prev.px + prev.dx * s, prev.pz + prev.dz * s];
    }
    const maxMiter = Math.max(Math.abs(at(i)), Math.abs(at((i - 1 + n) % n))) * 3 + 0.001;
    const travel = Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]);
    if (travel > maxMiter) {
      const k = maxMiter / travel;
      p = [pts[i][0] + (p[0] - pts[i][0]) * k, pts[i][1] + (p[1] - pts[i][1]) * k];
    }
    out.push(p);
  }
  return out;
}

/** Where two segments cross, with both parameters, or null. */
function segCross(a, b, c, d) {
  const rx = b[0] - a[0];
  const rz = b[1] - a[1];
  const sx = d[0] - c[0];
  const sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, p: [a[0] + rx * t, a[1] + rz * t] };
}

/**
 * Split a closed ring on an open polyline and return the half containing
 * `keep`. The polyline is pushed 80 m past both of its own ends first: the
 * retaining wall is surveyed only where it stands, and it has to reach clear
 * across the peninsula to divide anything.
 */
function cutRing(ring, cut, keep) {
  const beyond = (from, to, m) => {
    const dx = to[0] - from[0];
    const dz = to[1] - from[1];
    const len = Math.hypot(dx, dz) || 1;
    return [to[0] + (dx / len) * m, to[1] + (dz / len) * m];
  };
  const ext = cut.map((p) => p.slice());
  ext.unshift(beyond(cut[1], cut[0], 80));
  ext.push(beyond(cut[cut.length - 2], cut[cut.length - 1], 80));

  const hits = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    for (let j = 0; j + 1 < ext.length; j++) {
      const h = segCross(a, b, ext[j], ext[j + 1]);
      if (h) hits.push({ i, t: h.t, j, p: h.p });
    }
  }
  if (hits.length !== 2) return null;
  hits.sort((p, q) => p.i - q.i || p.t - q.t);

  const half = (h0, h1) => {
    const out = [h0.p.slice()];
    for (let i = h0.i + 1; i <= (h1.i < h0.i ? h1.i + ring.length : h1.i); i++) {
      out.push(ring[i % ring.length].slice());
    }
    out.push(h1.p.slice());
    if (h1.j >= h0.j) for (let j = h1.j; j > h0.j; j--) out.push(ext[j].slice());
    else for (let j = h1.j + 1; j <= h0.j; j++) out.push(ext[j].slice());
    return out;
  };

  const a = half(hits[0], hits[1]);
  return pointInRing(keep[0], keep[1], a) ? a : half(hits[1], hits[0]);
}

function shapeFrom(pts, holes = []) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], -pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], -pts[i][1]);
  shape.closePath();
  for (const hole of holes) {
    const path = new THREE.Path();
    path.moveTo(hole[0][0], -hole[0][1]);
    for (let i = 1; i < hole.length; i++) path.lineTo(hole[i][0], -hole[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

/**
 * Triangulate a ring and split every triangle until no edge is longer than
 * `maxEdge`, so the mesh has enough interior vertices to be draped over a
 * height field instead of spanning it in one flat plate.
 */
function draped(ring, level, offset, maxEdge = 9, holes = [], tile = 6) {
  const flat = new THREE.ShapeGeometry(shapeFrom(ring, holes));
  const src = flat.attributes.position;
  const idx = flat.index;
  let tris = [];
  for (let i = 0; i < idx.count; i += 3) {
    const t = [];
    for (let k = 0; k < 3; k++) {
      const j = idx.getX(i + k);
      t.push(src.getX(j), -src.getY(j));
    }
    tris.push(t);
  }
  flat.dispose();

  const limit = maxEdge * maxEdge;
  for (let pass = 0; pass < 7; pass++) {
    let split = false;
    const next = [];
    for (const t of tris) {
      let worst = 0;
      let e = -1;
      for (let k = 0; k < 3; k++) {
        const a = k * 2;
        const b = ((k + 1) % 3) * 2;
        const d = (t[a] - t[b]) ** 2 + (t[a + 1] - t[b + 1]) ** 2;
        if (d > worst) {
          worst = d;
          e = k;
        }
      }
      if (worst <= limit) {
        next.push(t);
        continue;
      }
      split = true;
      const i0 = e * 2;
      const i1 = ((e + 1) % 3) * 2;
      const i2 = ((e + 2) % 3) * 2;
      const mx = (t[i0] + t[i1]) * 0.5;
      const mz = (t[i0 + 1] + t[i1 + 1]) * 0.5;
      next.push([t[i0], t[i0 + 1], mx, mz, t[i2], t[i2 + 1]]);
      next.push([mx, mz, t[i1], t[i1 + 1], t[i2], t[i2 + 1]]);
    }
    tris = next;
    if (!split) break;
  }

  const pos = new Float32Array(tris.length * 9);
  let p = 0;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const x = t[k * 2];
      const z = t[k * 2 + 1];
      pos[p++] = x;
      pos[p++] = level(x, z) + offset;
      pos[p++] = z;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  return worldUV(geom, tile);
}

/** Closed band between two rings, draped on the height field. */
function bandGeometry(outer, inner, level, offset, tile = 6) {
  const pos = [];
  const n = outer.length;
  const push = (p) => pos.push(p[0], level(p[0], p[1]) + offset, p[1]);
  for (let i = 0; i < n; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % n];
    const c = inner[(i + 1) % n];
    const d = inner[i];
    if (Math.hypot(a[0] - d[0], a[1] - d[1]) < 0.05 && Math.hypot(b[0] - c[0], b[1] - c[1]) < 0.05) continue;
    push(a);
    push(d);
    push(c);
    push(a);
    push(c);
    push(b);
  }
  if (!pos.length) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  return worldUV(geom, tile);
}

/** Paved ribbon along a centreline, mitred at the joints. */
function ribbon(pts, halfW, level, offset, tile = 6) {
  if (pts.length < 2) return null;
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    left.push([pts[i][0] - dz * halfW, pts[i][1] + dx * halfW]);
    right.push([pts[i][0] + dz * halfW, pts[i][1] - dx * halfW]);
  }
  const pos = [];
  const push = (p) => pos.push(p[0], level(p[0], p[1]) + offset, p[1]);
  for (let i = 0; i + 1 < pts.length; i++) {
    push(left[i]);
    push(right[i]);
    push(right[i + 1]);
    push(left[i]);
    push(right[i + 1]);
    push(left[i + 1]);
  }
  if (!pos.length) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  return worldUV(geom, tile);
}

/**
 * Wall running along a polyline: one box per segment, each dropped far enough
 * below its top to bury itself in whatever it is retaining.
 */
function wallBoxes(line, thick, topAt, depth, closed = false) {
  const out = [];
  const n = closed ? line.length : line.length - 1;
  for (let i = 0; i < n; i++) {
    const a = line[i];
    const b = line[(i + 1) % line.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.4) continue;
    const mx = (a[0] + b[0]) * 0.5;
    const mz = (a[1] + b[1]) * 0.5;
    const top = topAt(mx, mz, -dz / len, dx / len);
    // Overlap the segments slightly so mitred corners do not open a slot.
    const box = new THREE.BoxGeometry(len + thick, depth, thick);
    box.rotateY(-Math.atan2(dz, dx));
    box.translate(mx, top - depth * 0.5, mz);
    out.push(box);
  }
  return out;
}

function tintGeom(geom, r, g, b, jitter, seed = 0) {
  const pos = geom.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const n = (hash01(pos.getX(i) * 0.7 + seed, pos.getZ(i) * 0.7 - seed) - 0.5) * jitter;
    col[i * 3] = Math.max(0, r + n);
    col[i * 3 + 1] = Math.max(0, g + n);
    col[i * 3 + 2] = Math.max(0, b + n * 0.6);
  }
  geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geom;
}

/**
 * `mergeGeometries` returns null unless every input agrees on both its index
 * and its attribute set. The box and cylinder primitives used here are indexed
 * and carry a `uv`; the hand-built strips are neither, so everything is
 * reconciled first — otherwise whole assemblies silently vanish.
 */
function addMerged(group, geoms, material, cast = true, receive = true) {
  const usable = geoms.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g));
  if (!usable.length) return null;
  const tinted = usable.some((g) => g.attributes.color);
  for (const g of usable) {
    if (!g.attributes.uv) worldUV(g, 6);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (tinted && !g.attributes.color) {
      const white = new Float32Array(g.attributes.position.count * 3).fill(1);
      g.setAttribute('color', new THREE.Float32BufferAttribute(white, 3));
    }
  }
  const merged = mergeGeometries(usable, false);
  for (const g of usable) g.dispose();
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  group.add(mesh);
  return mesh;
}

/* ------------------------------------------------------------------ */
/* the park's own datum                                                */
/* ------------------------------------------------------------------ */

/**
 * A smoothed plateau under the park.
 *
 * The city terrain grid is 40 m and the river mask pulls every cell near a bank
 * down toward the riverbed, so sampling it directly makes the deck sag into the
 * water along the whole bulkhead. Sampling only the cells that fall on park
 * land and growing those outward keeps the carved channel out of the average
 * entirely, and three box blurs then turn what is left into a plateau: the
 * Point is 30 ft of fill behind a wall, not a slope into the river.
 */
function makeDatum(yFn, ring) {
  const res = 18;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  minX -= res * 4;
  minZ -= res * 4;
  const cols = Math.ceil((maxX + res * 4 - minX) / res) + 1;
  const rows = Math.ceil((maxZ + res * 4 - minZ) / res) + 1;

  let h = new Float32Array(cols * rows);
  const land = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + c * res;
      const z = minZ + r * res;
      const i = r * cols + c;
      h[i] = yFn(x, z);
      land[i] = pointInRing(x, z, ring) ? 1 : 0;
    }
  }

  // Grow the land samples outward so the blur kernel always has park ground to
  // read, even one cell past the boundary.
  for (let grow = 0; grow < 4; grow++) {
    const next = land.slice();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (land[i]) continue;
        let s = 0;
        let k = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
            if (!land[rr * cols + cc]) continue;
            s += h[rr * cols + cc];
            k++;
          }
        }
        if (!k) continue;
        h[i] = s / k;
        next[i] = 1;
      }
    }
    land.set(next);
  }

  for (let pass = 0; pass < 3; pass++) {
    const blur = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let s = 0;
        let k = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
            s += h[rr * cols + cc];
            k++;
          }
        }
        blur[r * cols + c] = s / k;
      }
    }
    h = blur;
  }

  return (x, z) => {
    const fx = Math.min(cols - 1.001, Math.max(0, (x - minX) / res));
    const fz = Math.min(rows - 1.001, Math.max(0, (z - minZ) / res));
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fz);
    const tx = fx - c0;
    const tz = fz - r0;
    const a = h[r0 * cols + c0];
    const b = h[r0 * cols + c0 + 1];
    const c = h[(r0 + 1) * cols + c0];
    const d = h[(r0 + 1) * cols + c0 + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
}

/**
 * The park's three terraces as one continuous height field: the lawns and
 * woodland deck, the fountain terrace 1.5 m below it at the tip, and the
 * riverfront promenades 2.2 m below the deck inside the bulkhead. Transitions
 * are ramped over a few metres and then covered by retaining walls, which is
 * cheaper and far more robust than clipping three separate polygons.
 *
 * The Great Lawn also carries the shallow crown it has in life, high enough
 * that the Fort Duquesne tracery reads against the sky from the promenade.
 */
function makeLevels(datum, promenadeInner, yFn) {
  const mound = [-762, -70];
  return (x, z) => {
    let y = datum(x, z) + DECK_LIFT;

    const md = Math.hypot(x - mound[0], z - mound[1]);
    y += 0.85 * smooth01((112 - md) / 90);

    // Signed distance to the terrace edge: negative on the fountain side.
    let bestD = Infinity;
    let plazaSigned = Infinity;
    for (let i = 0; i + 1 < PLAZA_EDGE.length; i++) {
      const s = segDistance(x, z, ...PLAZA_EDGE[i], ...PLAZA_EDGE[i + 1]);
      if (s.d < bestD) {
        bestD = s.d;
        plazaSigned = s.side >= 0 ? s.d : -s.d;
      }
    }
    const plaza = PLAZA_DROP * smooth01(0.5 - plazaSigned / TRANSITION);

    let near = Infinity;
    for (let i = 0; i < promenadeInner.length; i++) {
      const a = promenadeInner[i];
      const b = promenadeInner[(i + 1) % promenadeInner.length];
      near = Math.min(near, segDistance(x, z, a[0], a[1], b[0], b[1]).d);
    }
    const signed = pointInRing(x, z, promenadeInner) ? -near : near;
    const walk = WALK_DROP * smooth01(0.5 + signed / TRANSITION);

    // main.js lays the generic landcover turf at yFn + 0.45 and does not cut a
    // hole in it for the Point, so anything the terracing drops below that is
    // simply buried. The floor is what keeps the fountain terrace and both
    // riverwalks on the surface where the terrain grid reads the fill low.
    return Math.max(y - Math.max(plaza, walk), yFn(x, z) + FLOOR_CLEAR);
  };
}

/* ------------------------------------------------------------------ */
/* the fountain                                                        */
/* ------------------------------------------------------------------ */

function circle(cx, cz, r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

/**
 * 800,000 gallons of water in a 200 ft basin throwing a single jet 150 ft up.
 * The granite rim is deliberately low and broad: it is the bench the whole city
 * sits on, and the apron outside it is scored with radial joints.
 */
function buildFountain(group, level, mats) {
  const plazaY = level(FOUNTAIN[0], FOUNTAIN[1]);
  const rim = circle(FOUNTAIN[0], FOUNTAIN[1], BASIN_R + 2.4, 64);
  const inner = circle(FOUNTAIN[0], FOUNTAIN[1], BASIN_R, 64);
  const flatY = () => plazaY;

  const granite = [];
  granite.push(bandGeometry(rim, inner, flatY, 0.62));
  const rimSide = (ring, top, bottom) => {
    const pos = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      pos.push(a[0], plazaY + bottom, a[1], b[0], plazaY + bottom, b[1], b[0], plazaY + top, b[1]);
      pos.push(a[0], plazaY + bottom, a[1], b[0], plazaY + top, b[1], a[0], plazaY + top, a[1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  };
  granite.push(rimSide(rim, 0.62, -0.8));
  granite.push(rimSide(inner.slice().reverse(), 0.62, -0.8));

  // A seating step outside the rim: the whole 630 ft edge of the basin is sat
  // on, and in every photograph of the Point it is two courses, not one lip.
  const bench = circle(FOUNTAIN[0], FOUNTAIN[1], BASIN_R + 6.2, 64);
  granite.push(bandGeometry(bench, rim, flatY, 0.26));
  granite.push(rimSide(bench, 0.26, -0.6));

  // Radial joints in the apron, the paving pattern that fans out from the rim,
  // and the two concentric bands that break it — the apron is scored, not laid
  // as one slab, and from the air that fan is what identifies the terrace.
  const joints = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r0 = BASIN_R + 7;
    const r1 = BASIN_R + 22;
    const bar = new THREE.BoxGeometry(r1 - r0, 0.16, 0.4);
    bar.rotateY(-a);
    bar.translate(
      FOUNTAIN[0] + Math.cos(a) * (r0 + r1) * 0.5,
      level(FOUNTAIN[0] + Math.cos(a) * (r0 + r1) * 0.5, FOUNTAIN[1] + Math.sin(a) * (r0 + r1) * 0.5) + 0.06,
      FOUNTAIN[1] + Math.sin(a) * (r0 + r1) * 0.5,
    );
    joints.push(bar);
  }
  for (const r of [BASIN_R + 14.5, BASIN_R + 22]) {
    const ring = circle(FOUNTAIN[0], FOUNTAIN[1], r, 72);
    const inner = circle(FOUNTAIN[0], FOUNTAIN[1], r - 0.8, 72);
    joints.push(bandGeometry(ring, inner, (x, z) => level(x, z), 0.07));
  }
  addMerged(group, granite, mats.granite);
  addMerged(group, joints, mats.wall, false, true);

  // The basin is aerated to the point of being opaque under the jet, so it is
  // far paler and flatter than the rivers either side of it.
  const basin = new THREE.Mesh(
    new THREE.CylinderGeometry(BASIN_R - 0.2, BASIN_R - 0.2, 0.5, 64),
    mat(0x22414f, { roughness: 0.52, metalness: 0.02 }),
  );
  basin.position.set(FOUNTAIN[0], plazaY + 0.05, FOUNTAIN[1]);
  basin.receiveShadow = true;
  group.add(basin);

  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 3.4, 1.9, 20), mats.granite);
  nozzle.position.set(FOUNTAIN[0], plazaY + 0.6, FOUNTAIN[1]);
  nozzle.castShadow = true;
  group.add(nozzle);

  /**
   * The jet is the reason anybody photographs the Point: 6,000 gallons a minute
   * through one nozzle, 150 ft up.
   *
   * The core is alpha-blended, not additive: aerated water at that volume is
   * genuinely opaque, and an additive core disappears whenever the jet crosses
   * something bright, because the tone mapping has nowhere left to go. The
   * surrounding haze is additive, which is what makes it read as lit spray.
   *
   * Either way the shells would show a hard silhouette, so the vertex alpha is
   * graded down each one's height and the ends dissolve instead.
   */
  const spray = (opacity, additive) =>
    new THREE.MeshBasicMaterial({
      color: 0xf0f6fb,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      vertexColors: true,
      toneMapped: !additive,
    });

  /**
   * The river surface is transparent too, and its bounding sphere often sorts
   * nearer than the fountain, so without an explicit order the water is painted
   * over the jet and the column vanishes against the far bank — which is
   * exactly the view the jet exists for.
   */
  const addSpray = (mesh) => {
    mesh.renderOrder = 6;
    mesh.castShadow = false;
    group.add(mesh);
    return mesh;
  };

  // Four-component vertex colours give MeshBasicMaterial a per-vertex alpha,
  // which scales the additive shells and cuts the alpha-blended core alike.
  const fade = (geom, yBase, yTop, aBase, aTop) => {
    const p = geom.attributes.position;
    const col = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      const t = clamp01((p.getY(i) - yBase) / (yTop - yBase || 1));
      col[i * 4] = 1;
      col[i * 4 + 1] = 1;
      col[i * 4 + 2] = 1;
      col[i * 4 + 3] = aBase + (aTop - aBase) * t;
    }
    geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    return geom;
  };

  const JET_H = 45.7;
  const jetBase = plazaY + 1.2;
  const shell = (r0, r1, h, o, aBase, aTop, additive = true, y0 = 0) => {
    const geom = new THREE.CylinderGeometry(r1, r0, h, 18, 1, true);
    geom.translate(FOUNTAIN[0], jetBase + y0 + h * 0.5, FOUNTAIN[1]);
    addSpray(
      new THREE.Mesh(fade(geom, jetBase + y0, jetBase + y0 + h, aBase, aTop), spray(o, additive)),
    );
  };

  // Dense off the nozzle, feathering as it loses velocity. Photographs of the
  // Point show the column spreading to something like 10 m across before it
  // breaks up, which is why it still reads from the far bank; a jet modelled at
  // its true nozzle width would be a hairline at any useful viewing distance.
  shell(0.8, 1.9, JET_H, 0.95, 0.95, 0, false);
  shell(1.5, 3.6, JET_H * 1.02, 0.5, 0.42, 0, false);
  // The lit haze around the column, split in two so it swells through the
  // middle and dissolves at the top instead of ending on a hard rim.
  shell(2.1, 4.4, JET_H * 0.6, 0.26, 0, 0.7);
  shell(4.4, 7.2, JET_H * 0.55, 0.26, 0.7, 0, true, JET_H * 0.6);

  // The plume breaking up at the crown: spread over a quarter of the jet's
  // height rather than capping it, because the column does not stop at 150 ft,
  // it comes apart there.
  const crown = [];
  for (let i = 0; i < 12; i++) {
    const a = i * 2.4;
    const r = 0.9 + hash01(i * 5, 3) * 4.1;
    const puff = new THREE.IcosahedronGeometry(1.5 + hash01(i, 9) * 1.7, 1);
    puff.translate(
      FOUNTAIN[0] + Math.cos(a) * r,
      jetBase + JET_H * (0.79 + hash01(i * 3, 7) * 0.29),
      FOUNTAIN[1] + Math.sin(a) * r,
    );
    crown.push(puff);
  }
  const plumeGeom = mergeGeometries(crown, false);
  for (const c of crown) c.dispose();
  addSpray(
    new THREE.Mesh(
      fade(plumeGeom, jetBase + JET_H * 0.72, jetBase + JET_H * 1.14, 0.6, 0.02),
      spray(0.42, false),
    ),
  );

  // Wind-carried mist lying over the basin, where the fallback lands.
  const mistGeom = new THREE.CylinderGeometry(BASIN_R - 13, BASIN_R - 1, 9, 28, 1, true);
  mistGeom.translate(FOUNTAIN[0], plazaY + 4.5, FOUNTAIN[1]);
  addSpray(new THREE.Mesh(fade(mistGeom, plazaY, plazaY + 9, 0.9, 0), spray(0.16, true)));

  // Perimeter bubblers: a ring of short arcs inside the rim.
  const arcs = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const r = BASIN_R - 3.4;
    const cone = new THREE.ConeGeometry(0.34, 1.8 + hash01(i, 4) * 1.2, 6, 1, true);
    cone.translate(FOUNTAIN[0] + Math.cos(a) * r, plazaY + 1.4, FOUNTAIN[1] + Math.sin(a) * r);
    arcs.push(cone);
  }
  const bubGeom = mergeGeometries(arcs, false);
  for (const a of arcs) a.dispose();
  addSpray(new THREE.Mesh(fade(bubGeom, plazaY + 0.2, plazaY + 3, 0.85, 0.02), spray(0.6, false)));
}

/* ------------------------------------------------------------------ */
/* the Portal Bridge                                                   */
/* ------------------------------------------------------------------ */

function buildPortal(group, level, mats) {
  const [a, b, c, d] = PORTAL;
  // a->b is the 160 ft depth the pedestrian route passes through; b->c is the
  // 182 ft arch span between the two abutments.
  const depth = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const span = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const cx = (a[0] + b[0] + c[0] + d[0]) / 4;
  const cz = (a[1] + b[1] + c[1] + d[1]) / 4;
  const yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const baseY = level(cx, cz);

  const RISE = 7.0;
  const DECK_Y = 7.6;
  const ribs = 4;
  const geoms = [];

  const local = (u, v, y) => {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    return [cx + u * cosY - v * sinY, baseY + y, cz + u * sinY + v * cosY];
  };
  const quad = (pos, p0, p1, p2, p3) => {
    pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  };

  // Four ribs and the three vault soffits between them, as one shell.
  const shell = [];
  const steps = 16;
  const arcY = (t) => RISE * (1 - (2 * t - 1) ** 2);
  const ribU = [];
  for (let i = 0; i < ribs; i++) ribU.push((-0.5 + i / (ribs - 1)) * depth * 0.78);

  for (let i = 0; i < ribs; i++) {
    const u = ribU[i];
    const w = 1.5;
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const v0 = (t0 - 0.5) * span;
      const v1 = (t1 - 0.5) * span;
      const y0 = arcY(t0);
      const y1 = arcY(t1);
      for (const side of [-1, 1]) {
        quad(
          shell,
          local(u + (side * w) / 2, v0, y0),
          local(u + (side * w) / 2, v1, y1),
          local(u + (side * w) / 2, v1, y1 + 1.5),
          local(u + (side * w) / 2, v0, y0 + 1.5),
        );
      }
      quad(
        shell,
        local(u - w / 2, v0, y0),
        local(u + w / 2, v0, y0),
        local(u + w / 2, v1, y1),
        local(u - w / 2, v1, y1),
      );
    }
  }

  // Vault soffits: shallow barrels dropped between neighbouring ribs.
  for (let i = 0; i + 1 < ribs; i++) {
    const u0 = ribU[i] + 0.75;
    const u1 = ribU[i + 1] - 0.75;
    const bays = 5;
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      for (let k = 0; k < bays; k++) {
        const p0 = k / bays;
        const p1 = (k + 1) / bays;
        const ua = u0 + (u1 - u0) * p0;
        const ub = u0 + (u1 - u0) * p1;
        const sag = (p) => 1.4 * (1 - (2 * p - 1) ** 2);
        quad(
          shell,
          local(ua, (t0 - 0.5) * span, arcY(t0) + 1.5 - sag(p0)),
          local(ub, (t0 - 0.5) * span, arcY(t0) + 1.5 - sag(p1)),
          local(ub, (t1 - 0.5) * span, arcY(t1) + 1.5 - sag(p1)),
          local(ua, (t1 - 0.5) * span, arcY(t1) + 1.5 - sag(p0)),
        );
      }
    }
  }
  const shellGeom = new THREE.BufferGeometry();
  shellGeom.setAttribute('position', new THREE.Float32BufferAttribute(shell, 3));
  shellGeom.computeVertexNormals();
  geoms.push(shellGeom);

  // Deck slab carrying the eight lanes, with a parapet on each long edge so the
  // 25 ft wall of highway reads as a bridge and not as a plate of concrete.
  const slab = new THREE.BoxGeometry(depth, 1.1, span + 6);
  slab.rotateY(-yaw);
  slab.translate(cx, baseY + DECK_Y, cz);
  geoms.push(slab);

  for (const side of [-1, 1]) {
    const parapet = new THREE.BoxGeometry(1.0, 1.3, span + 6);
    parapet.rotateY(-yaw);
    const p = local((side * depth) / 2, 0, 0);
    parapet.translate(p[0], baseY + DECK_Y + 1.2, p[2]);
    geoms.push(parapet);
  }

  for (const side of [-1, 1]) {
    const wall = [];
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const u = (side * depth) / 2;
      quad(
        wall,
        local(u, (t0 - 0.5) * span, arcY(t0) + 1.4),
        local(u, (t1 - 0.5) * span, arcY(t1) + 1.4),
        local(u, (t1 - 0.5) * span, DECK_Y - 0.55),
        local(u, (t0 - 0.5) * span, DECK_Y - 0.55),
      );
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3));
    g.computeVertexNormals();
    geoms.push(g);
  }

  // Abutments at the two springings.
  for (const side of [-1, 1]) {
    const ab = new THREE.BoxGeometry(depth + 2, DECK_Y + 1.6, 7);
    ab.rotateY(-yaw);
    const p = local(0, (side * (span + 7)) / 2, 0);
    ab.translate(p[0], baseY + (DECK_Y + 1.6) / 2 - 1, p[2]);
    geoms.push(ab);
  }

  addMerged(group, geoms, mats.portal);

  // The reflecting pool that fills the passage floor, with the footbridge that
  // crosses it.
  // Shallow, still and shaded under the arch, so it is far darker and much less
  // mirror-like than the rivers; at the rivers' roughness it blows out to a
  // sheet of white the moment the sun is anywhere near the specular lobe.
  const poolRing = openRing(POOL);
  const pool = new THREE.Mesh(
    draped(poolRing, level, 0.18, 12),
    mat(0x22414f, { roughness: 0.34, metalness: 0.12 }),
  );
  pool.receiveShadow = true;
  group.add(pool);

  const kerb = wallBoxes(poolRing, 1.1, (x, z) => level(x, z) + 0.45, 1.6, true);
  addMerged(group, kerb, mats.granite);

  const walkway = ribbon(
    [local(-depth * 0.5 - 10, 0, 0), local(depth * 0.5 + 10, 0, 0)].map((p) => [p[0], p[2]]),
    2.2,
    level,
    0.95,
  );
  const rails = [];
  if (walkway) {
    rails.push(walkway);
    for (const side of [-1, 1]) {
      const p0 = local(-depth * 0.5 - 10, side * 2.2, 0);
      const p1 = local(depth * 0.5 + 10, side * 2.2, 0);
      const len = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
      const rail = new THREE.BoxGeometry(len, 0.12, 0.12);
      rail.rotateY(-yaw);
      rail.translate((p0[0] + p1[0]) / 2, level(cx, cz) + 1.95, (p0[2] + p1[2]) / 2);
      rails.push(rail);
    }
  }
  addMerged(group, rails, mats.portal);
}

/* ------------------------------------------------------------------ */
/* planting                                                            */
/* ------------------------------------------------------------------ */

/**
 * A broadleaf crown: three overlapping lobes, each an icosahedron pushed about
 * so the silhouette breaks up. The Point is planted in sycamore, oak, maple and
 * honey locust, so nothing here is a cone.
 */
function crownGeometry(seed) {
  // One subdivided icosahedron rather than a cluster of coarse ones: at the
  // same 80 triangles it spends them on the whole silhouette instead of on
  // four overlapping shells, and the facets end up small enough that a canopy
  // seen from the promenade stops reading as folded paper.
  const geom = new THREE.IcosahedronGeometry(1, 1);
  const p = geom.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const theta = Math.atan2(v.z, v.x);
    const lift = clamp01(v.y * 0.5 + 0.5);
    // Three broad lobes around the stem, a flattened top and a hollow
    // underside: the shape a mature open-grown sycamore actually makes.
    let r =
      1 +
      0.2 * Math.sin(3 * theta + seed * 2.1) +
      0.12 * Math.sin(5 * theta - seed * 1.3) -
      0.3 * Math.max(0, 0.35 - lift) * 3;
    r += (hash01(v.x * 7.3 + seed * 11, v.z * 5.9 - v.y * 3.1) - 0.5) * 0.22;
    p.setXYZ(i, v.x * r, v.y * r * 0.82 + 0.1, v.z * r);
  }
  geom.computeVertexNormals();
  return geom;
}

/**
 * Canopy tints as sRGB hue/saturation/lightness. Sycamore is the palest and
 * greyest, red oak the darkest and bluest, honey locust the most yellow.
 */
const SPECIES = [
  { h: 0.24, s: 0.17, l: 0.21 },
  { h: 0.28, s: 0.27, l: 0.145 },
  { h: 0.225, s: 0.3, l: 0.18 },
  { h: 0.2, s: 0.33, l: 0.215 },
];

function buildTrees(group, level, spots) {
  if (!spots.length) return;
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();

  const trunkGeom = new THREE.CylinderGeometry(0.3, 0.46, 1, 6, 1, true);
  trunkGeom.translate(0, 0.5, 0);
  const trunks = new THREE.InstancedMesh(
    trunkGeom,
    mat(0xffffff, { roughness: 0.95, flatShading: true }),
    spots.length,
  );
  // Sycamore bark is nearly white where it has flaked, red oak almost black,
  // and a stand of one brown makes the belts read as a plantation.
  const bark = new Float32Array(spots.length * 3);

  const VARIANTS = 4;
  const buckets = Array.from({ length: VARIANTS }, () => []);
  spots.forEach((s, i) => buckets[Math.floor(hash01(s[0] * 0.7, s[1] * 1.3) * VARIANTS) % VARIANTS].push(i));

  spots.forEach(([x, z], i) => {
    const h = hash01(x * 1.1, z * 0.9);
    const s = 0.74 + h * 0.86;
    const y = level(x, z);
    const crownR = 4.3 * s * (0.84 + hash01(z, x) * 0.3);
    const stem = 6.4 * s + crownR * 0.5;
    dummy.position.set(x, y - 0.4, z);
    dummy.scale.set(s, stem + 0.4, s);
    dummy.rotation.set(0, h * 6.28, 0);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    const b = hash01(z * 1.7, x * 2.9);
    tint.setHSL(0.07 + b * 0.03, 0.1 + b * 0.12, 0.13 + b * 0.19, THREE.SRGBColorSpace);
    bark[i * 3] = tint.r;
    bark[i * 3 + 1] = tint.g;
    bark[i * 3 + 2] = tint.b;
  });
  trunks.instanceColor = new THREE.InstancedBufferAttribute(bark, 3);
  trunks.castShadow = true;
  trunks.receiveShadow = true;
  group.add(trunks);

  for (let v = 0; v < VARIANTS; v++) {
    const idx = buckets[v];
    if (!idx.length) continue;
    const crowns = new THREE.InstancedMesh(
      crownGeometry(v + 1),
      mat(0xffffff, { roughness: 0.95, flatShading: true }),
      idx.length,
    );
    const colors = new Float32Array(idx.length * 3);
    idx.forEach((i, n) => {
      const [x, z] = spots[i];
      const h = hash01(x * 1.1, z * 0.9);
      const s = 0.74 + h * 0.86;
      const crownR = 4.3 * s * (0.84 + hash01(z, x) * 0.3);
      const stem = 6.4 * s + crownR * 0.5;
      dummy.position.set(x, level(x, z) + stem, z);
      dummy.scale.set(crownR, crownR * (0.82 + hash01(x, z * 3) * 0.34), crownR);
      dummy.rotation.set(0, hash01(z * 2, x) * 6.28, 0);
      dummy.updateMatrix();
      crowns.setMatrixAt(n, dummy.matrix);
      // Instance colours are consumed in linear space, so the lightness has to
      // be authored as sRGB and converted or the canopy comes out bleached.
      // Each variant gets its own base hue and value: the Point is planted in
      // sycamore, red oak, sugar maple and honey locust, and read from the air
      // that mix is a mottle, not one green.
      const sp = SPECIES[v % SPECIES.length];
      const t = hash01(x * 2.3, z * 1.7);
      tint.setHSL(
        sp.h + t * 0.03,
        sp.s + t * 0.1,
        sp.l + t * 0.05,
        THREE.SRGBColorSpace,
      );
      colors[n * 3] = tint.r;
      colors[n * 3 + 1] = tint.g;
      colors[n * 3 + 2] = tint.b;
    });
    crowns.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    group.add(crowns);
  }
}

/* ------------------------------------------------------------------ */
/* street furniture                                                    */
/* ------------------------------------------------------------------ */

function benchGeometry(x, z, y, yaw) {
  const parts = [];
  const seat = new THREE.BoxGeometry(2.0, 0.11, 0.52);
  seat.translate(0, 0.46, 0);
  const back = new THREE.BoxGeometry(2.0, 0.42, 0.09);
  back.translate(0, 0.72, -0.22);
  parts.push(seat, back);
  for (const s of [-1, 1]) {
    const leg = new THREE.BoxGeometry(0.11, 0.46, 0.46);
    leg.translate(s * 0.82, 0.23, 0);
    parts.push(leg);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.rotateY(yaw);
  merged.translate(x, y, z);
  return merged;
}

function lampGeometry(x, z, y) {
  const post = new THREE.CylinderGeometry(0.1, 0.16, 6.4, 6, 1, true);
  post.translate(x, y + 3.2, z);
  const head = new THREE.CylinderGeometry(0.4, 0.22, 0.7, 8);
  head.translate(x, y + 6.6, z);
  const merged = mergeGeometries([post, head], false);
  post.dispose();
  head.dispose();
  return merged;
}

/* ------------------------------------------------------------------ */
/* main build                                                          */
/* ------------------------------------------------------------------ */

export function buildPointStatePark(yFn, pointPark) {
  const g = new THREE.Group();
  g.name = 'point-state-park';
  if (!pointPark?.f || pointPark.f.length < 8) return g;

  const ring = openRing(pointPark.f);
  const n = ring.length;

  // Mark the boundary vertices that are river wall rather than street frontage,
  // walking forward from the Monongahela end past the tip to the Allegheny end.
  const nearest = (p) => {
    let best = 0;
    let bd = Infinity;
    ring.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const i0 = nearest(RIVER_FROM);
  const i1 = nearest(RIVER_TO);
  const river = new Array(n).fill(false);
  for (let k = 0; k <= (i1 - i0 + n) % n; k++) river[(i0 + k) % n] = true;

  const edgeInset = [];
  for (let i = 0; i < n; i++) edgeInset.push(river[i] && river[(i + 1) % n] ? PROMENADE_W : 0);
  const promenadeInner = insetRing(ring, edgeInset);

  const datum = makeDatum(yFn, ring);
  const level = makeLevels(datum, promenadeInner, yFn);

  // The city ground is a #8a8680 map under vertex tints near 0.4, so its paving
  // lands about 0.10 in linear albedo and its turf about 0.13. The park has to
  // sit in that range or the whole peninsula flares white from the air; these
  // maps carry the albedo and the vertex colours only drift around 1.0.
  const concrete = concreteTexture();
  const mats = {
    paving: mat(0xffffff, { roughness: 0.9, map: concrete, vertexColors: true }),
    // The default surface between the mapped polygons: rougher, greyer grass
    // than the mown lawns, which is what the verges and the ground under the
    // interchange actually are.
    ground: mat(0xffffff, {
      roughness: 0.99,
      map: turfTexture('#445b33', '88,116,64', false),
      vertexColors: true,
    }),
    lawn: mat(0xffffff, {
      roughness: 0.99,
      map: turfTexture('#4b6538', '98,128,70', true),
      vertexColors: true,
    }),
    understorey: mat(0xffffff, {
      roughness: 0.99,
      map: turfTexture('#36452b', '70,90,52', false),
      vertexColors: true,
    }),
    walk: mat(0xf2eee6, { roughness: 0.84, map: concrete }),
    granite: mat(0x817b72, { roughness: 0.55, metalness: 0.06 }),
    // The traceries are laid in pale precast, not the grey granite of the rim:
    // they have to read as a drawing on the grass from the air, which is the
    // whole point of marking a fort that is no longer there.
    trace: mat(0xa9a396, { roughness: 0.8 }),
    wall: mat(0x635e55, { roughness: 0.9 }),
    // The portal's arch shell, spandrels and vault soffits are open strips
    // whose winding cannot be made consistent between the inside and the
    // outside of a three-hinged arch, so they are drawn from both faces.
    portal: mat(0x8b857b, { roughness: 0.86, side: THREE.DoubleSide }),
    water: mat(0x27536a, {
      roughness: 0.14,
      metalness: 0.35,
      emissive: 0x0d2a3a,
      emissiveIntensity: 0.16,
    }),
    metal: mat(0x2f3336, { roughness: 0.5, metalness: 0.6 }),
    timber: mat(0x53412c, { roughness: 0.88 }),
  };

  /* ---- surfaces ------------------------------------------------- */

  const base = draped(ring, level, 0, 9);
  tintGeom(base, 1, 1, 0.95, 0.26, 5);
  const baseMesh = new THREE.Mesh(base, mats.ground);
  baseMesh.receiveShadow = true;
  g.add(baseMesh);

  // The fountain terrace: the whole nose of the peninsula west of the retaining
  // wall is one paved deck, which is what makes the tip read pale from the air
  // and from the far bank. Everything else paved is a walk or a car park.
  const terrace = cutRing(promenadeInner, PLAZA_EDGE, FOUNTAIN);
  const paveGeoms = [terrace && draped(terrace, level, 0.05, 8)];
  paveGeoms.push(bandGeometry(ring, promenadeInner, level, 0.05));
  for (const poly of PAVED) paveGeoms.push(draped(poly, level, 0.06, 10));
  for (const geom of paveGeoms) if (geom) tintGeom(geom, 1, 0.99, 0.96, 0.16, 3);
  addMerged(g, paveGeoms, mats.paving, false, true);

  const lawnGeoms = [];
  for (const poly of GRASS) {
    const geom = draped(poly, level, 0.11, 8, [], 9);
    tintGeom(geom, 1, 1.02, 0.94, 0.22, 11);
    lawnGeoms.push(geom);
  }
  addMerged(g, lawnGeoms, mats.lawn, false, true);

  const woodGeoms = [];
  for (const poly of WOODS) {
    const geom = draped(poly, level, 0.14, 10, [], 9);
    tintGeom(geom, 1, 1, 0.94, 0.3, 23);
    woodGeoms.push(geom);
  }
  addMerged(g, woodGeoms, mats.understorey, false, true);

  const walkGeoms = [];
  for (const p of PATHS) walkGeoms.push(ribbon(p.c, p.w * 0.5, level, 0.2));
  addMerged(g, walkGeoms, mats.walk, false, true);

  /* ---- retaining walls, bulkhead and railings -------------------- */

  const stone = [];

  // Between the deck and the fountain terrace.
  stone.push(
    ...wallBoxes(
      PLAZA_EDGE.slice(1, -1),
      1.3,
      (x, z, nx, nz) => level(x + nx * 5, z + nz * 5) + 0.16,
      3.4,
    ),
  );

  // Between the upper park and the riverfront promenade, on the river side only.
  const promWall = [];
  for (let i = 0; i < n; i++) {
    if (!(river[i] && river[(i + 1) % n])) {
      if (promWall.length > 1) {
        stone.push(
          ...wallBoxes(promWall, 1.4, (x, z) => {
            const c = [-700, -60];
            const d = Math.hypot(c[0] - x, c[1] - z) || 1;
            return level(x + ((c[0] - x) / d) * 7, z + ((c[1] - z) / d) * 7) + 0.18;
          }, 4),
        );
      }
      promWall.length = 0;
      continue;
    }
    if (!promWall.length) promWall.push(promenadeInner[i]);
    promWall.push(promenadeInner[(i + 1) % n]);
  }
  if (promWall.length > 1) {
    stone.push(
      ...wallBoxes(promWall, 1.4, (x, z) => {
        const c = [-700, -60];
        const d = Math.hypot(c[0] - x, c[1] - z) || 1;
        return level(x + ((c[0] - x) / d) * 7, z + ((c[1] - z) / d) * 7) + 0.18;
      }, 4),
    );
  }

  // The bulkhead itself: the park is a filled peninsula held behind a wall that
  // runs the whole river frontage, so it has to reach the water, not the deck.
  const skirt = [];
  const pos = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const inA = promenadeInner[i];
    const inB = promenadeInner[(i + 1) % n];
    // Only the river frontage stands proud; where the boundary is a kerb line
    // against Commonwealth Place the wall is flush and simply buried.
    const lip = river[i] && river[(i + 1) % n] ? 0.55 : 0.04;
    const topA = level(a[0] + (inA[0] - a[0]) * 0.4 + 0.01, a[1] + (inA[1] - a[1]) * 0.4) + lip;
    const topB = level(b[0] + (inB[0] - b[0]) * 0.4 + 0.01, b[1] + (inB[1] - b[1]) * 0.4) + lip;
    const botA = Math.min(yFn(a[0], a[1]) - 1.5, topA - 3.5);
    const botB = Math.min(yFn(b[0], b[1]) - 1.5, topB - 3.5);
    pos.push(a[0], topA, a[1], a[0], botA, a[1], b[0], botB, b[1]);
    pos.push(a[0], topA, a[1], b[0], botB, b[1], b[0], topB, b[1]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (lip > 0.1 && len > 0.5) {
      const cap = new THREE.BoxGeometry(len + 1, 0.5, 1.6);
      cap.rotateY(-Math.atan2(b[1] - a[1], b[0] - a[0]));
      cap.translate((a[0] + b[0]) / 2, (topA + topB) / 2 - 0.08, (a[1] + b[1]) / 2);
      skirt.push(cap);
    }
  }
  const skirtGeom = new THREE.BufferGeometry();
  skirtGeom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  skirtGeom.computeVertexNormals();
  skirt.push(skirtGeom);
  addMerged(g, [...stone, ...skirt], mats.wall);

  /* ---- steps ------------------------------------------------------ */

  const treads = [];
  for (const [a, b] of STEPS) {
    const ya = level(a[0], a[1]);
    const yb = level(b[0], b[1]);
    if (Math.abs(ya - yb) < 0.5) continue;
    const [lo, hi] = ya < yb ? [a, b] : [b, a];
    const yLo = Math.min(ya, yb);
    const yHi = Math.max(ya, yb);
    const risers = Math.max(3, Math.round((yHi - yLo) / 0.17));
    const dx = hi[0] - lo[0];
    const dz = hi[1] - lo[1];
    const yaw = -Math.atan2(dz, dx);
    for (let k = 0; k < risers; k++) {
      const t = (k + 0.5) / risers;
      const step = new THREE.BoxGeometry(Math.hypot(dx, dz) / risers + 0.1, 0.34, 4.6);
      step.rotateY(yaw);
      step.translate(lo[0] + dx * t, yLo + ((yHi - yLo) * (k + 1)) / risers - 0.17, lo[1] + dz * t);
      treads.push(step);
    }
  }
  addMerged(g, treads, mats.granite);

  /* ---- traceries -------------------------------------------------- */

  const trace = [];
  for (const line of TRACERIES) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [ax, az] = line[i];
      const [bx, bz] = line[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.3) continue;
      const bar = new THREE.BoxGeometry(len + 1.6, 0.26, 1.6);
      bar.rotateY(-Math.atan2(dz, dx));
      bar.translate(ax + dx * 0.5, level(ax + dx * 0.5, az + dz * 0.5) + 0.22, az + dz * 0.5);
      trace.push(bar);
    }
  }
  addMerged(g, trace, mats.trace, false, true);

  /* ---- fountain and portal ---------------------------------------- */

  buildFountain(g, level, mats);
  buildPortal(g, level, mats);

  /* ---- pump house and flagpole ------------------------------------ */

  const pumpRing = openRing(PUMP_HOUSE);
  let px = 0;
  let pz = 0;
  for (const [x, z] of pumpRing) {
    px += x / pumpRing.length;
    pz += z / pumpRing.length;
  }
  const pumpY = level(px, pz);
  const pumpWalls = [];
  for (let i = 0; i < pumpRing.length; i++) {
    const a = pumpRing[i];
    const b = pumpRing[(i + 1) % pumpRing.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const w = new THREE.BoxGeometry(len + 0.4, 4.6, 0.4);
    w.rotateY(-Math.atan2(b[1] - a[1], b[0] - a[0]));
    w.translate((a[0] + b[0]) / 2, pumpY + 2.3, (a[1] + b[1]) / 2);
    pumpWalls.push(w);
  }
  pumpWalls.push(draped(pumpRing, () => pumpY + 4.75, 0, 20));
  addMerged(g, pumpWalls, mats.portal);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.2, 17, 8),
    mat(0xd8d4cc, { roughness: 0.5, metalness: 0.3 }),
  );
  pole.position.set(FLAGPOLE[0], level(FLAGPOLE[0], FLAGPOLE[1]) + 8.5, FLAGPOLE[1]);
  pole.castShadow = true;
  g.add(pole);

  /* ---- benches, lamps, railings ----------------------------------- */

  const benches = [];
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + 0.12;
    const r = BASIN_R + 13.5;
    const x = FOUNTAIN[0] + Math.cos(a) * r;
    const z = FOUNTAIN[1] + Math.sin(a) * r;
    benches.push(benchGeometry(x, z, level(x, z) + 0.02, -a + Math.PI / 2));
  }
  for (const p of PATHS) {
    if (p.w < 4) continue;
    for (let i = 0; i + 1 < p.c.length; i += 2) {
      const a = p.c[i];
      const b = p.c[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 26) continue;
      const t = 0.5;
      const x = a[0] + (b[0] - a[0]) * t - ((b[1] - a[1]) / len) * 3.6;
      const z = a[1] + (b[1] - a[1]) * t + ((b[0] - a[0]) / len) * 3.6;
      benches.push(benchGeometry(x, z, level(x, z) + 0.02, -Math.atan2(b[1] - a[1], b[0] - a[0])));
    }
  }
  addMerged(g, benches, mats.timber);

  const posts = [];
  const underPortal = openRing(PORTAL);
  for (const p of PATHS) {
    if (p.w < 4) continue;
    let carry = 0;
    for (let i = 0; i + 1 < p.c.length; i++) {
      const a = p.c[i];
      const b = p.c[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = 34 - carry; s < len; s += 34) {
        const t = s / len;
        const x = a[0] + (b[0] - a[0]) * t - ((b[1] - a[1]) / len) * 3.2;
        const z = a[1] + (b[1] - a[1]) * t + ((b[0] - a[0]) / len) * 3.2;
        // Nothing stands in the reflecting pool or under the 25 ft soffit.
        if (pointInRing(x, z, underPortal)) continue;
        posts.push(lampGeometry(x, z, level(x, z)));
      }
      carry = (carry + len) % 34;
    }
  }

  // Guard rail along the river wall.
  for (let i = 0; i < n; i++) {
    if (!(river[i] && river[(i + 1) % n])) continue;
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const yaw = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    const railTop = (t) => {
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      const inn = promenadeInner[i];
      return level(x + (inn[0] - x) * 0.3, z + (inn[1] - z) * 0.3) + 0.5;
    };
    for (let s = 0; s < len; s += 4.5) {
      const t = s / len;
      const post = new THREE.BoxGeometry(0.1, 1.05, 0.1);
      post.translate(a[0] + (b[0] - a[0]) * t, railTop(t) + 0.52, a[1] + (b[1] - a[1]) * t);
      posts.push(post);
    }
    for (const h of [0.62, 1.02]) {
      const rail = new THREE.BoxGeometry(len, 0.07, 0.07);
      rail.rotateY(yaw);
      rail.translate((a[0] + b[0]) / 2, (railTop(0) + railTop(1)) / 2 + h, (a[1] + b[1]) / 2);
      posts.push(rail);
    }
  }
  addMerged(g, posts, mats.metal);

  /* ---- planting ---------------------------------------------------- */

  // The fountain terrace is a bare paved deck — the nearest canopy in any
  // photograph of the Point stands behind the retaining wall — so surveyed
  // trees that land on it are trees standing just off it in the OSM trace.
  const spots = TREES.filter((t) => !(terrace && pointInRing(t[0], t[1], terrace))).map((t) => t.slice());
  const nearPath = (x, z) => {
    for (const p of PATHS) {
      for (let i = 0; i + 1 < p.c.length; i++) {
        const s = segDistance(x, z, p.c[i][0], p.c[i][1], p.c[i + 1][0], p.c[i + 1][1]);
        if (s.d < p.w * 0.5 + 1.8) return true;
      }
    }
    return false;
  };
  // The wood belts read as closed canopy in every aerial of the Point, so they
  // are filled on a jittered grid at mature crown spacing rather than scattered.
  // Jittered by more than the step: at anything less the lattice survives the
  // scatter and the belts read from the promenade as an orchard.
  for (let x = -960; x <= -420; x += 7.2) {
    for (let z = -270; z <= 160; z += 7.2) {
      const jx = x + (hash01(x * 3, z) - 0.5) * 9;
      const jz = z + (hash01(z, x * 3) - 0.5) * 9;
      if (hash01(jx * 0.3, jz * 0.3) > 0.84) continue;
      let inWood = false;
      for (const w of WOODS) {
        if (pointInRing(jx, jz, w)) {
          inWood = true;
          break;
        }
      }
      if (!inWood || nearPath(jx, jz)) continue;
      spots.push([jx, jz]);
    }
  }

  // Allées: the riverfront promenades are planted in a single regular row on
  // the landward side, which is what gives the Point its corridor of shade.
  // The Great Lawn stays clear — that openness is the whole design.
  const taken = (x, z) => {
    for (const s of spots) if (Math.hypot(s[0] - x, s[1] - z) < 9) return true;
    return false;
  };
  for (const p of PATHS) {
    if (p.w < 4) continue;
    let carry = 0;
    for (let i = 0; i + 1 < p.c.length; i++) {
      const a = p.c[i];
      const b = p.c[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1) continue;
      const nx = -(b[1] - a[1]) / len;
      const nz = (b[0] - a[0]) / len;
      for (let s = 16 - carry; s < len; s += 16) {
        const t = s / len;
        // Plant on the side away from the water, so the row stands between the
        // promenade and the lawn instead of over the bulkhead.
        const inward = pointInRing(a[0] + nx * 12, a[1] + nz * 12, ring) ? 1 : -1;
        const off = p.w * 0.5 + 3.6;
        const x = a[0] + (b[0] - a[0]) * t + nx * off * inward;
        const z = a[1] + (b[1] - a[1]) * t + nz * off * inward;
        if (!pointInRing(x, z, ring)) continue;
        let onLawn = false;
        for (const w of GRASS) {
          if (pointInRing(x, z, w)) {
            onLawn = true;
            break;
          }
        }
        if (onLawn || nearPath(x, z) || taken(x, z)) continue;
        if (Math.hypot(x - FOUNTAIN[0], z - FOUNTAIN[1]) < BASIN_R + 26) continue;
        spots.push([x, z]);
      }
      carry = (carry + len) % 16;
    }
  }
  buildTrees(g, level, spots);

  return g;
}
