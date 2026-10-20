import { standard } from '../../materials/Materials.js';
import { ShaderModule } from '../../engine/gpu/Shader.js';
import { commonModule } from '../../engine/render/wgsl/common.js';
import { srgb, terrainShadingModule } from '../terrain/TerrainShading.js';

// Procedural materials for the walls and the houses of Óbidos (no textures: patterns from the mesh
// uvs, which are in metres, plus the shared detail noise texture for breakup). The geometry carries
//   tint  vec3  stone tone / trim paint colour (the barra and the window surrounds)
//   vdata vec4  stone:   x seed, y weathering 0..1
//               plaster: x facade length (m), y storeys, z seed, w 1 = facade with windows and doors
//                        (0 = a blank wall), plus 0.4 x the ground's slope along it (-0.95..0.95);
//                        w 2-4: the finishes of townTiles (azulejos, a painted vault, flat paint)
//               roof:    x seed, y age 0..1
//
// WGSL (townModule, prefix `town`):
//   fn townMasonry( uv, seed, wear, px ) -> TownSurf   rubble limestone in rough courses, lime mortar,
//                                                       rain streaks, lichen, a damp dark foot
//   fn townPlaster( uv, P, d, trim, px ) -> TownSurf    whitewash with a painted base band (barra),
//                                                       painted window and door surrounds, dark openings
//   fn townTiles( uv, P, d, trim, px ) -> TownSurf      blue-and-white azulejos, a painted vault, or
//                                                       flat paint in the trim colour (stone dressings)
//   fn townRoof( uv, seed, age, px ) -> TownSurf        Roman (canudo) terracotta tiles in channels
// TownSurf { albedo, rough, hd (bump height, m), ao }.
const C = {
	stoneA: srgb( 0.66, 0.65, 0.6 ),
	stoneB: srgb( 0.56, 0.55, 0.51 ),
	stoneC: srgb( 0.7, 0.66, 0.57 ),
	stoneD: srgb( 0.46, 0.45, 0.42 ),
	mortar: srgb( 0.72, 0.7, 0.64 ),
	lichenGrey: srgb( 0.74, 0.74, 0.69 ),
	lichenOrange: srgb( 0.74, 0.52, 0.24 ),
	damp: srgb( 0.27, 0.27, 0.22 ),
	white: srgb( 0.93, 0.92, 0.89 ),
	whiteWarm: srgb( 0.92, 0.89, 0.83 ),
	grime: srgb( 0.55, 0.53, 0.48 ),
	glass: srgb( 0.05, 0.06, 0.07 ),
	shutter: srgb( 0.3, 0.2, 0.13 ),
	door: srgb( 0.4, 0.26, 0.15 ),
	tileA: srgb( 0.72, 0.38, 0.23 ),
	tileB: srgb( 0.62, 0.31, 0.2 ),
	tileC: srgb( 0.78, 0.47, 0.3 ),
	tileOld: srgb( 0.48, 0.34, 0.27 ),
	tileLichen: srgb( 0.66, 0.62, 0.5 ),
	azWhite: srgb( 0.9, 0.9, 0.86 ),
	azBlue: srgb( 0.15, 0.27, 0.6 ),
	azBlueDeep: srgb( 0.07, 0.12, 0.36 ),
	paintCream: srgb( 0.86, 0.79, 0.64 ),
	paintOchre: srgb( 0.76, 0.55, 0.27 ),
	paintRed: srgb( 0.52, 0.2, 0.13 ),
};

const consts = Object.entries( C ).map( ( [ k, v ] ) => `const TC_${ k }: vec3f = ${ v };` ).join( '\n' );

const WGSL = /* wgsl */`
${ consts }

struct TownSurf {
	albedo: vec3f,
	rough: f32,
	hd: f32,
	ao: f32,
	em: vec3f,
};

// lamps and lit windows: on from dusk (the same ramp as the local lights)
fn townNightRamp() -> f32 {
	return smoothstep( 0.15, 0.75, frame.night );
}

fn townHash( p: vec2f ) -> f32 {
	var q = fract( p * vec2f( 0.1031, 0.1030 ) );
	q += dot( q, q.yx + 33.33 );
	return fract( ( q.x + q.y ) * q.x );
}

fn townNoise( p: vec2f ) -> vec4f {
	return textureSampleLevel( terrainDetailTex, smpLinearRepeat, p, 0.0 );
}

// irregular cells (jittered-grid Voronoi): x = distance to the centre, y = to the border, zw = cell id
fn townVoronoi( q: vec2f ) -> vec4f {
	let cell = floor( q );
	let f = fract( q );
	var d1 = 9.0; var d2 = 9.0; var id = vec2f( 0.0 );
	for ( var j = -1; j <= 1; j++ ) {
		for ( var i = -1; i <= 1; i++ ) {
			let c = cell + vec2f( f32( i ), f32( j ) );
			let o = vec2f( townHash( c ), townHash( c + 17.3 ) ) * 0.75 + 0.125;
			let d = length( vec2f( f32( i ), f32( j ) ) + o - f );
			if ( d < d1 ) { d2 = d1; d1 = d; id = c; } else if ( d < d2 ) { d2 = d; }
		}
	}
	return vec4f( d1, ( d2 - d1 ) * 0.5, id );
}

// rubble limestone: uv in metres (u along the wall, v = height). Irregular stones, wider than tall,
// in lime mortar; rain streaks, lichens
fn townMasonry( uvIn: vec2f, seed: f32, wear: f32, px: f32 ) -> TownSurf {
	let n0 = townNoise( uvIn / 3.1 + seed * 7.0 );
	let n1 = townNoise( uvIn / 0.9 + seed * 3.0 + 0.31 );
	let cs = vec2f( 0.44, 0.19 );
	let v = townVoronoi( uvIn / cs + seed * 13.0 );
	let h1 = townHash( v.zw + seed );
	let h2 = townHash( v.zw * 1.7 + 4.1 );
	var col = mix( TC_stoneB, TC_stoneA, h1 );
	col = mix( col, TC_stoneC, smoothstep( 0.7, 0.95, h2 ) * 0.6 );
	col = mix( col, TC_stoneD, smoothstep( 0.86, 1.0, townHash( v.zw + 9.3 ) ) * 0.8 );
	// big tonal patches (repairs, different quarries) and the grain of the stone
	col = col * ( ( n0.w - 0.5 ) * 0.35 + 1.0 ) * ( ( n1.w - 0.5 ) * 0.2 + 1.0 );
	let pxS = px / 0.3;
	let joint = 1.0 - smoothstep( 0.04, 0.1 + pxS, v.y );
	let fade = smoothstep( 0.04, 0.25, px );
	col = mix( col, TC_mortar * ( n0.y * 0.2 + 0.85 ), joint * 0.75 * ( 1.0 - fade ) );
	col = mix( col, mix( TC_stoneB, TC_mortar, 0.25 ), fade * 0.4 );
	// weathering: rain streaks running down, lichens
	let streak = townNoise( vec2f( uvIn.x / 1.7, uvIn.y / 23.0 ) + seed ).w;
	col = col * ( 1.0 - smoothstep( 0.52, 0.72, streak ) * 0.3 * wear );
	let lich = smoothstep( 0.62, 0.78, n0.x + ( n1.y - 0.5 ) * 0.4 );
	col = mix( col, TC_lichenGrey, lich * 0.35 );
	col = mix( col, TC_lichenOrange, smoothstep( 0.8, 0.9, n1.x + n0.z * 0.2 ) * 0.35 * wear );
	var o: TownSurf;
	o.em = vec3f( 0.0 );
	o.albedo = col;
	o.rough = mix( 0.88, 0.95, joint );
	o.hd = ( smoothstep( 0.0, 0.12, v.y ) * 0.012 + n1.x * 0.008 ) * ( 1.0 - fade );
	o.ao = mix( 1.0, 0.7, joint * ( 1.0 - fade ) );
	return o;
}

// rectangle mask with antialiasing (centre c, half size hs)
fn townRect( p: vec2f, c: vec2f, hs: vec2f, aa: f32 ) -> f32 {
	let d = abs( p - c ) - hs;
	let k = max( d.x, d.y );
	return 1.0 - smoothstep( - aa, aa, k );
}

// Whitewashed facade. uv: u along the facade from its start (m), v = height above the lowest ground
// along it. d: vdata (length, storeys, seed, facade flag + 0.4 x ground slope); trim: paint colour.
// On a sloping street the base band and the street-level row of openings follow the ground; the rows
// above stay level, and those the ground has climbed past are left out.
fn townPlaster( uv: vec2f, P: vec3f, d: vec4f, trim: vec3f, px: f32 ) -> TownSurf {
	let n0 = townNoise( P.xz / 4.3 + P.y / 7.0 );
	let n1 = townNoise( vec2f( uv.x, uv.y ) / 1.3 + d.z * 5.0 );
	let facade = round( d.w );
	let slope = ( d.w - facade ) * 2.5;
	// the ground's height above v = 0 at u
	let g0 = max( 0.0, - slope * d.x );
	let gy = uv.y - ( g0 + slope * uv.x );
	var col = mix( TC_white, TC_whiteWarm, n0.w * 0.8 );
	// grime: splashes at the foot, streaks under the eaves and sills
	let foot = 1.0 - smoothstep( 0.0, 1.4, gy + ( n1.y - 0.5 ) * 0.5 );
	col = mix( col, TC_grime, foot * 0.35 );
	col = col * ( 1.0 - smoothstep( 0.55, 0.8, townNoise( vec2f( uv.x / 1.1, uv.y / 9.0 ) + d.z ).w ) * 0.12 );
	var hd = n1.x * 0.004;
	var rough = 0.92;
	var ao = 1.0;
	var litEm = vec3f( 0.0 );
	let aa = max( px, 0.004 ) * 1.2;
	// painted base band (barra), ~0.7 m
	let barH = 0.55 + fract( d.z * 13.7 ) * 0.4;
	let barK = 1.0 - smoothstep( barH - aa, barH + aa, gy );
	col = mix( col, trim * ( n1.w * 0.15 + 0.9 ), barK );
	hd += barK * 0.004;
	if ( facade > 0.5 ) {
		// openings: a regular rhythm along the facade, one row per storey; the ground floor has a door
		let L = max( d.x, 0.5 );
		let bays = max( 1.0, floor( L / 3.2 ) );
		let bayW = L / bays;
		let bay = clamp( floor( uv.x / bayW ), 0.0, bays - 1.0 );
		let cx = ( bay + 0.5 ) * bayW;
		let storeyH = 3.0;
		// the street-level row at this bay: the storey nearest the ground there, its openings set
		// from the ground (rows below it are under the street)
		let gb = g0 + slope * cx;
		let street = max( 0.0, round( gb / storeyH ) );
		let storey = max( floor( max( uv.y, 0.0 ) / storeyH ), street );
		let inBuilding = storey < d.y;
		let hb = townHash( vec2f( bay, d.z * 31.0 ) );
		let atStreet = storey == street;
		let isDoor = atStreet && ( hb < 0.45 || bay == floor( bays * fract( d.z * 7.3 ) ) );
		var c = vec2f( cx, storey * storeyH + 1.75 );
		var hs = vec2f( 0.45, 0.62 );
		if ( isDoor ) {
			c = vec2f( cx, gb + 1.15 );
			hs = vec2f( 0.6, 1.15 );
		} else if ( atStreet ) {
			c = vec2f( cx, gb + 1.65 );
			hs = vec2f( 0.42, 0.55 );
		}
		let show = select( 0.0, 1.0, inBuilding && L > 1.8 && hb < 0.93 );
		// painted surround (cantaria): the trim colour, then the dark opening (glass / door)
		let surround = townRect( uv, c, hs + vec2f( 0.14 ), aa ) * show;
		let hole = townRect( uv, c, hs, aa ) * show;
		col = mix( col, trim * 0.95, surround * ( 1.0 - hole ) );
		var opening = select( TC_glass, TC_door, isDoor );
		// shutters half open on some windows, panes / door planks
		let lx = ( uv.x - c.x ) / hs.x;
		let ly = ( uv.y - c.y ) / hs.y;
		if ( ! isDoor ) {
			let mull = smoothstep( 0.06, 0.0, abs( lx ) ) + smoothstep( 0.05, 0.0, abs( ly - 0.2 ) );
			opening = mix( opening, TC_white * 0.7, sat( mull ) * 0.8 );
			let sh = townHash( vec2f( bay * 3.1, storey + d.z ) );
			opening = mix( opening, TC_shutter * ( n1.z * 0.4 + 0.8 ), select( 0.0, 1.0, sh > 0.6 && abs( lx ) > 0.35 ) );
		} else {
			let plank = sin( lx * 12.0 ) * 0.5 + 0.5;
			opening = opening * ( plank * 0.25 + 0.85 );
		}
		col = mix( col, opening, hole );
		// some windows lit after dusk (warm, behind the panes; brighter low in the room)
		let lit = select( 0.0, 1.0, ! isDoor && townHash( vec2f( bay * 7.1 + 3.0, storey + d.z * 17.0 ) ) > 0.55 );
		litEm = vec3f( 1.0, 0.62, 0.3 ) * lit * hole * townNightRamp() * ( 1.4 - smoothstep( -1.0, 1.0, ly ) * 0.6 ) * 2.2;
		rough = mix( rough, select( 0.15, 0.7, isDoor ), hole );
		hd = hd + surround * 0.012 - hole * 0.08;
		ao = mix( ao, 0.6, hole );
		// a sill under the windows
		let sill = townRect( uv, vec2f( c.x, c.y - hs.y - 0.17 ), vec2f( hs.x + 0.2, 0.05 ), aa ) * show * select( 1.0, 0.0, isDoor );
		col = mix( col, trim * 0.85, sill );
		hd = hd + sill * 0.03;
	}
	var o: TownSurf;
	o.em = litEm;
	o.albedo = col;
	o.rough = rough;
	o.hd = hd;
	o.ao = ao;
	return o;
}

// The finishes inside the oratory at Porta da Vila (d.w):
//   2  azulejos, 14 cm square, from height d.x to d.y: a patterned dado, a border, then figured panels
//      (a blue brush drawing) in frames, with a border again at the top
//   3  a painted vault: ochre, red and blue scrolls on cream
//   4  flat paint in the trim colour (the stone of the arch and the niche)
fn townTiles( uv: vec2f, P: vec3f, d: vec4f, trim: vec3f, px: f32 ) -> TownSurf {
	let n0 = townNoise( P.xz / 3.7 + P.y / 5.0 + d.z );
	var col = trim * ( n0.w * 0.12 + 0.94 );
	var rough = 0.8;
	var hd = n0.x * 0.003;
	var ao = 1.0;
	if ( d.w < 2.5 ) {
		let T = 0.14;
		let f = fract( uv / T );
		let cell = floor( uv / T );
		let aa = max( px, 0.002 ) / T * 1.5;
		let fade = smoothstep( 0.008, 0.03, px ); // far off, the pattern melts into its average
		let h = uv.y - d.x;
		// the dado: a ring at each corner and a dot in the middle, so four tiles make a flower
		let q = abs( f - 0.5 );
		let ring = 1.0 - smoothstep( 0.05, 0.05 + aa, abs( length( 0.5 - q ) - 0.3 ) );
		let dot = 1.0 - smoothstep( 0.13, 0.13 + aa, length( q ) );
		let dado = max( ring, dot );
		// the panels: the outlines and the shading of a drawing, from noise
		// (the noise's w channel is the smooth one)
		let figure = townNoise( uv / 2.3 + d.z * 3.0 ).w + ( townNoise( uv / 0.7 + 0.5 ).w - 0.5 ) * 0.2;
		let line = 1.0 - smoothstep( 0.006, 0.014, abs( fract( figure * 5.0 ) - 0.5 ) / 5.0 );
		let shade = smoothstep( 0.4, 0.62, townNoise( uv / 1.6 + 7.1 ).w ) * 0.9;
		let panel = max( line * 0.95, shade );
		// borders: over the dado, under the top, and frames between panels 1.6 m apart
		let top = d.y - d.x;
		let fx = fract( uv.x / 1.6 ) * 1.6;
		let band = select( 0.0, 1.0, ( h > 1.0 && h < 1.28 ) || ( h > top - 0.28 && h < top ) || min( fx, 1.6 - fx ) < 0.14 );
		var blue = mix( panel, dado, select( 0.0, 1.0, h < 1.0 ) );
		blue = mix( blue, 0.85 - dot * 0.6, band );
		blue = mix( blue, 0.45, fade );
		let glaze = TC_azWhite * ( 0.95 + 0.05 * townHash( cell ) );
		col = mix( glaze, mix( TC_azBlue, TC_azBlueDeep, smoothstep( 0.6, 1.0, blue ) ), sat( blue ) );
		// the grout between the tiles
		let e = min( min( f.x, 1.0 - f.x ), min( f.y, 1.0 - f.y ) );
		let grout = ( 1.0 - smoothstep( 0.0, 0.03 + aa, e ) ) * ( 1.0 - fade );
		col = mix( col, TC_mortar * 0.85, grout * 0.7 );
		rough = mix( 0.2, 0.9, grout );
		hd = - grout * 0.002 + townHash( cell + 3.1 ) * 0.0015;
	} else if ( d.w < 3.5 ) {
		let a = townNoise( uv / 1.4 + d.z ).w;
		let b = townNoise( uv / 0.9 + 1.3 ).w;
		let c = townNoise( uv / 2.1 + 4.7 ).w;
		col = TC_paintCream * ( n0.w * 0.15 + 0.9 );
		col = mix( col, TC_paintOchre, smoothstep( 0.48, 0.55, a ) );
		col = mix( col, TC_paintRed, smoothstep( 0.55, 0.6, b ) * 0.85 );
		col = mix( col, TC_azBlueDeep, smoothstep( 0.58, 0.63, c ) * 0.7 );
		// the scrolls' dark outlines
		let s = a + ( b - 0.5 ) * 0.3;
		col = col * ( 1.0 - ( 1.0 - smoothstep( 0.0, 0.04, abs( fract( s * 4.0 ) - 0.5 ) ) ) * 0.5 );
		rough = 0.85;
		ao = 0.9;
	}
	var o: TownSurf;
	o.em = vec3f( 0.0 );
	o.albedo = col;
	o.rough = rough;
	o.hd = hd;
	o.ao = ao;
	return o;
}

// Roman (canudo) tiles: uv.x across the slope, uv.y down the slope (m)
fn townRoof( uv: vec2f, seed: f32, age: f32, px: f32 ) -> TownSurf {
	let w = 0.21; // channel width
	let lane = floor( uv.x / w );
	let fx = fract( uv.x / w );
	let course = floor( uv.y / 0.38 + townHash( vec2f( lane, seed ) ) * 0.4 );
	let fy = fract( uv.y / 0.38 + townHash( vec2f( lane, seed ) ) * 0.4 );
	let cap = fract( lane * 0.5 ) > 0.25; // alternate lanes: caps (convex) over pans (concave)
	let prof = sin( fx * 3.14159 );
	let h1 = townHash( vec2f( lane, course ) + seed * 13.0 );
	var col = mix( TC_tileB, TC_tileA, h1 );
	col = mix( col, TC_tileC, smoothstep( 0.75, 0.95, townHash( vec2f( lane * 1.3, course ) ) ) * 0.7 );
	let n = townNoise( uv / 2.7 + seed );
	col = mix( col, TC_tileOld, smoothstep( 0.4, 0.8, n.w + age * 0.4 ) * 0.6 );
	col = mix( col, TC_tileLichen, smoothstep( 0.7, 0.85, n.x + age * 0.2 ) * 0.5 );
	let fade = smoothstep( 0.03, 0.12, px );
	let shade = mix( select( 0.75 + prof * 0.25, 0.85 + prof * 0.2, cap ), 0.9, fade );
	// the overlap shadow at the lower edge of each course
	let lip = smoothstep( 0.85, 1.0, fy ) * ( 1.0 - fade );
	col = col * shade * ( 1.0 - lip * 0.35 );
	var o: TownSurf;
	o.em = vec3f( 0.0 );
	o.albedo = col;
	o.rough = 0.75;
	o.hd = ( select( - prof * 0.02, prof * 0.05, cap ) + fy * 0.015 ) * ( 1.0 - fade );
	o.ao = 1.0 - lip * 0.3;
	return o;
}
`;

let _module = null;

export function townModule() {

	return _module || ( _module = new ShaderModule( { name: 'town', deps: [ commonModule, terrainShadingModule() ], code: WGSL } ) );

}

const VERTEX = 'o.vTint = v.tint; o.vData = v.vdata;';
const COMMON = {
	attributes: { tint: 'vec3f', vdata: 'vec4f' },
	varyings: { vTint: 'vec3f', vData: 'vec4f' },
	vertex: VERTEX,
};

function make( name, surface, extra = {} ) {

	const m = standard( { name, roughness: 0.9, metalness: 0, ...COMMON, ...extra } );
	m.modules = [ terrainShadingModule(), townModule() ];
	m.surface = surface;
	return m;

}

const PX = 'let px = max( length( dpdx( in.P ) ), length( dpdy( in.P ) ) );';

export function createTownMaterials() {

	return {
		// wall lanterns: dark iron (vdata.x = 0) and the glass (vdata.x = 1), glowing from dusk
		lantern: make( 'TownLantern', /* wgsl */`
	let glass = in.vs.vData.x > 0.5;
	s.albedo = select( vec3f( 0.03, 0.03, 0.028 ), vec3f( 0.9, 0.8, 0.6 ), glass );
	s.roughness = select( 0.5, 0.2, glass );
	s.emissive = select( vec3f( 0.0 ), vec3f( 1.0, 0.66, 0.34 ) * townNightRamp() * 7.0, glass );
` ),
		stone: make( 'TownStone', /* wgsl */`
	${ PX }
	let t = townMasonry( in.uv, in.vs.vData.x, in.vs.vData.y, px );
	s.albedo = t.albedo * in.vs.vTint;
	s.roughness = t.rough;
	s.normal = terrainPerturbNormal( in.P, in.N, t.hd, 1.0 );
	s.ao = t.ao;
` ),
		plaster: make( 'TownPlaster', /* wgsl */`
	${ PX }
	var t: TownSurf;
	if ( in.vs.vData.w > 1.5 ) {
		t = townTiles( in.uv, in.P, in.vs.vData, in.vs.vTint, px );
	} else {
		t = townPlaster( in.uv, in.P, in.vs.vData, in.vs.vTint, px );
	}
	s.albedo = t.albedo;
	s.roughness = t.rough;
	s.normal = terrainPerturbNormal( in.P, in.N, t.hd, 1.0 );
	s.ao = t.ao;
	s.emissive = t.em;
` ),
		roof: make( 'TownRoof', /* wgsl */`
	${ PX }
	let t = townRoof( in.uv, in.vs.vData.x, in.vs.vData.y, px );
	s.albedo = t.albedo * in.vs.vTint;
	s.roughness = t.rough;
	s.normal = terrainPerturbNormal( in.P, in.N, t.hd, 1.0 );
	s.ao = t.ao;
` ),
	};

}
