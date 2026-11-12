import * as THREE from '../engine/index.js';

// Shared world layout. Coordinates in metres, y up (metres above sea level, Copernicus DEM datum).
// x points east, z points south (north = -z), origin at the centre of the walls' bounding box
// (39.36158° N, 9.15721° W). The sun rises in the east (+x) and sets in the west (-x).
//
// Óbidos sits on a north-south limestone ridge: the castle at the north end, the main gate (Porta da
// Vila) near the south end, Rua Direita running between them. West of the walls the land falls to
// the flat Várzea (about 5 m); the long straight west wall looks over it toward the sunset.
export const WORLD = {
	terrainSize: 2048, // near heightmap domain (1 m texels), centred on the origin
	terrainRes: 2048,
	latitude: 39.3616,

	// where the player starts: just inside Porta da Vila, looking north up Rua Direita
	// (while working on one spot, start there with ?fly or a saved view instead of changing this)
	start: { position: new THREE.Vector3( - 49.5, 0, 214 ), yaw: - 0.1, pitch: - 0.02 },
	// the main gate and the castle keep (for the free camera / review views)
	gate: new THREE.Vector3( - 56, 0, 232 ),
	castle: new THREE.Vector3( 20, 0, - 205 ),
};
