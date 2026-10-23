// Óbidos world test (CPU only, no GPU): builds the terrain, the walls and the town from the geodata and
// walks them with the real Player and colliders.
//   - the terrain spans the plain (~5 m) to the ridge (~75 m) and the curtain encloses the town
//   - gates where the streets cross the curtain, flights of steps up onto the walls
//   - Rua Direita can be walked from Porta da Vila to the castle end
//   - Porta da Vila can be walked through, in by one arch and out by the other
//   - every flight of steps can be climbed onto the wall walk
//   - on the walk the parapet holds you in; stepping off the town side drops you into the street
//   node test/world-obidos.mjs
import { loadDEM, OSM } from '../src/world/obidos/Geo.js';
import { TerrainData } from '../src/world/TerrainData.js';
import { Colliders } from '../src/world/Colliders.js';
import { Walls } from '../src/world/obidos/Walls.js';
import { Town } from '../src/world/obidos/Town.js';
import { Player } from '../src/player/Player.js';
import { Scene, PerspectiveCamera } from '../src/engine/index.js';

let failures = 0;
const check = ( ok, msg ) => {

	console.log( `${ ok ? 'ok  ' : 'FAIL' } ${ msg }` );
	if ( ! ok ) failures ++;

};

const dem = await loadDEM();
const T = new TerrainData( dem );
const C = new Colliders();
const W = new Walls( { scene: new Scene(), terrain: T, colliders: C, materials: {} } );
const town = new Town( { scene: new Scene(), terrain: T, colliders: C, materials: {}, walls: W } );

check( T.heightAt( - 600, - 40 ) < 15, `the Várzea west of the walls is low (${ T.heightAt( - 600, - 40 ).toFixed( 1 ) } m)` );
check( T.heightAt( 20, - 205 ) > 60, `the castle end of the ridge is high (${ T.heightAt( 20, - 205 ).toFixed( 1 ) } m)` );
check( T.isInsideTown( - 30, 60 ) && ! T.isInsideTown( - 300, 0 ), 'the curtain encloses the town' );
check( T.gates.length >= 4, `gates where streets cross the curtain: ${ T.gates.length }` );
check( W.stairs.length >= 5, `flights of steps up onto the walls: ${ W.stairs.length }` );
check( town.buildings.length > 600, `houses: ${ town.buildings.length }` );

const keys = new Set();
const input = { down: ( k ) => keys.has( k ), hit: () => false, consumeLook: () => ( { x: 0, y: 0 } ) };
const P = new Player( { camera: new PerspectiveCamera(), input, terrain: T, colliders: C } );
const walkTo = ( x, z, maxSec = 40, near = 0.6 ) => {

	for ( let i = 0; i < maxSec * 60; i ++ ) {

		const dx = x - P.position.x, dz = z - P.position.z;
		if ( Math.hypot( dx, dz ) < near ) return true;
		P.yaw = Math.atan2( - dx, - dz );
		P.update( 1 / 60 );

	}

	return false;

};

keys.add( 'KeyW' );

// Rua Direita, gate to castle
const rd = OSM.streets.find( ( s ) => s.name === 'Rua Direita' ).pts;
P.placeAt( rd[ 0 ][ 0 ], 200, rd[ 0 ][ 1 ] );
let ok = true;
for ( let k = 1; k < rd.length && ok; k ++ ) ok = walkTo( rd[ k ][ 0 ], rd[ k ][ 1 ], 40, 0.8 );
check( ok, `walked Rua Direita to (${ P.position.x.toFixed( 0 ) }, ${ P.position.z.toFixed( 0 ) })` );

// in through Porta da Vila: the outer arch, across the tower, out through the inner arch
P.placeAt( - 58.7, T.heightAt( - 58.7, 241 ) + 0.2, 241 );
ok = true;
for ( const [ x, z ] of [ [ - 58.5, 234.9 ], [ - 57.9, 229.4 ], [ - 51.8, 229 ], [ - 51.1, 225 ], [ - 50.5, 220.3 ] ] ) if ( ok ) ok = walkTo( x, z, 20, 0.6 );
check( ok, `walked in through both arches of Porta da Vila to (${ P.position.x.toFixed( 0 ) }, ${ P.position.z.toFixed( 0 ) })` );
// straight on from the outer arch is the tower's town wall
P.placeAt( - 58.5, T.heightAt( - 58.5, 231 ) + 0.2, 231 );
const blocked = ! walkTo( - 58.5, 220, 6 );
check( blocked, `the tower's town wall stops you going straight on (${ P.position.z.toFixed( 1 ) })` );

// every flight of steps
let climbed = 0;
for ( const st of W.stairs ) {

	const b = st.bottom;
	P.placeAt( b.x, b.y + 1, b.z, P.yaw );
	keys.delete( 'KeyW' );
	for ( let i = 0; i < 20; i ++ ) P.update( 1 / 60 );
	keys.add( 'KeyW' );
	let up = true;
	for ( let k = st.steps.length - 2; k >= 0 && up; k -- ) up = walkTo( st.steps[ k ].x, st.steps[ k ].z, 5, 0.25 );
	if ( up && P.position.y > st.top - 0.3 ) climbed ++;
	else console.log( `     stuck on the flight at ( ${ st.x.toFixed( 0 ) }, ${ st.z.toFixed( 0 ) } ): y ${ P.position.y.toFixed( 2 ) } of ${ st.top.toFixed( 2 ) }` );

}

check( climbed === W.stairs.length, `climbed ${ climbed } / ${ W.stairs.length } flights of steps` );

// the L-shaped flight by Porta da Vila's inner arch comes out on the curtain walk
const pv = W.stairs.at( - 1 ).steps[ 0 ];
P.placeAt( pv.x, pv.y + 0.1, pv.z );
ok = walkTo( pv.x, 233.6, 5, 0.4 ) && walkTo( - 68, 234.2, 10, 0.5 ); // over the landing at its head
// (the tower stands higher than the curtain: the walk comes down from it, but stays well over the ground)
check( ok && P.position.y > T.heightAt( - 68, 234.2 ) + 4, `from the steps by Porta da Vila onto the curtain walk (y ${ P.position.y.toFixed( 1 ) })` );

// up the stepped lane, through the gateway beside it and along the Casa da Música's terrace
const ct = W.casaTerrace;
P.placeAt( W.lane[ 0 ].x + 1, T.heightAt( W.lane[ 0 ].x + 1, W.lane[ 0 ].z ) + 0.3, W.lane[ 0 ].z );
ok = true;
for ( const st of W.lane ) if ( ok && st.x >= ct.gate.x - 0.01 ) ok = walkTo( st.x, st.z, 5, 0.35 );
ok = ok && walkTo( ct.gate.x, ct.gate.z - 2.5, 5, 0.4 ) && walkTo( - 60.6, 205, 8, 0.4 ) && Math.abs( P.position.y - ct.floor ) < 0.1;
check( ok, `up the steps onto the Casa da Música's terrace (y ${ P.position.y.toFixed( 1 ) } of ${ ct.floor.toFixed( 1 ) })` );

// along the walk, then into the parapet, then off the town side
const S = W.curtain.samples;
const i0 = Math.floor( S.length * 0.3 );
const q0 = S[ i0 ];
P.placeAt( q0.x - q0.nx * 0.3, q0.y + 0.2, q0.z - q0.nz * 0.3 );
let onWalk = true;
for ( let k = i0 + 1; k < i0 + 60; k ++ ) {

	const q = S[ k ];
	walkTo( q.x - q.nx * 0.3, q.z - q.nz * 0.3, 5, 0.3 );
	if ( Math.abs( P.position.y - q.y ) > 0.4 ) onWalk = false;

}

check( onWalk, 'stayed on the wall walk for 36 m' );
const q = S[ i0 + 60 ];
P.placeAt( q.x, q.y + 0.1, q.z );
P.yaw = Math.atan2( - q.nx, - q.nz );
for ( let i = 0; i < 120; i ++ ) P.update( 1 / 60 );
const out = ( P.position.x - q.x ) * q.nx + ( P.position.z - q.z ) * q.nz;
check( out < 0.8 && P.position.y > q.y - 0.3, `the parapet holds (${ out.toFixed( 2 ) } m outward)` );
P.yaw = Math.atan2( q.nx, q.nz );
for ( let i = 0; i < 150; i ++ ) P.update( 1 / 60 );
check( P.position.y < q.y - 1.5, `stepping off the town side drops into the street (${ ( P.position.y - q.y ).toFixed( 1 ) } m)` );

console.log( failures ? `${ failures } failed` : 'all passed' );
process.exit( failures ? 1 : 0 );
