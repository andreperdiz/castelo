import { ShaderModule } from '../../engine/gpu/Shader.js';
import { commonModule } from '../../engine/render/wgsl/common.js';
import { srgb, terrainShadingModule } from './TerrainShading.js';

// The Óbidos countryside and town ground, shared by the near terrain and the far DEM mesh.
//
// WGSL (groundShadingModule(), prefix `ground`; needs terrainShadingModule for terrainDetailTex):
//   fn groundParcel( xz: vec2f ) -> GroundParcel
//       field patchwork: a warped, rotated brick layout of parcels (~60 x 60..140 m), each with a crop
//       picked by its hash. { id: 0..1, edge: distance to the parcel edge (m), uv: parcel-local metres
//       (x along the rows), rowAngle }
//   fn groundFarm( xz: vec2f, px: f32, macroT: f32 ) -> vec4f
//       albedo (linear) of the farmland at xz, a = bump height (m). px: pixel footprint (m).
//       Crops (October, after the harvest): golden stubble, red-brown ploughed earth, olive groves
//       on dry grass, vineyards in rows, green irrigated plots, fallow
//   fn groundScrub( xz: vec2f, px: f32, macroT: f32, detail: f32 ) -> vec4f   Mediterranean scrub / woodland
//   fn groundDryGrass( macroT: f32, detail: f32, slope: f32 ) -> vec3f
//   fn groundCobbles( xz: vec2f, px: f32 ) -> vec4f                          limestone setts (albedo, a = bump)
//   fn groundHash( p: vec2f ) -> f32
const C = {
	stubble: srgb( 0.68, 0.58, 0.4 ),
	stubbleLight: srgb( 0.76, 0.66, 0.47 ),
	plough: srgb( 0.5, 0.35, 0.25 ),
	ploughRed: srgb( 0.56, 0.32, 0.23 ),
	ploughDark: srgb( 0.36, 0.26, 0.19 ),
	dryGrass: srgb( 0.52, 0.5, 0.33 ),
	dryGrassPale: srgb( 0.62, 0.58, 0.41 ),
	greenPlot: srgb( 0.33, 0.4, 0.2 ),
	greenLush: srgb( 0.25, 0.34, 0.15 ),
	olive: srgb( 0.2, 0.24, 0.15 ),
	oliveLight: srgb( 0.32, 0.35, 0.24 ),
	vine: srgb( 0.36, 0.36, 0.18 ),
	vineSoil: srgb( 0.58, 0.47, 0.35 ),
	scrubDark: srgb( 0.13, 0.17, 0.09 ),
	scrub: srgb( 0.22, 0.26, 0.14 ),
	scrubDry: srgb( 0.42, 0.4, 0.26 ),
	hedge: srgb( 0.17, 0.21, 0.11 ),
	track: srgb( 0.66, 0.57, 0.43 ),
	settLight: srgb( 0.62, 0.6, 0.56 ),
	settMid: srgb( 0.47, 0.46, 0.43 ),
	settDark: srgb( 0.34, 0.34, 0.33 ),
	settWarm: srgb( 0.56, 0.51, 0.44 ),
	joint: srgb( 0.3, 0.29, 0.26 ),
};

const consts = Object.entries( C ).map( ( [ k, v ] ) => `const GC_${ k }: vec3f = ${ v };` ).join( '\n' );

const WGSL = /* wgsl */`
${ consts }

// cosine between the surface and the view (set by the caller before groundFarm): painted crowns
// and rows only read from above, at grazing angles they would be flat ellipses on the ground
var<private> groundNdV: f32 = 1.0;

fn groundHash( p: vec2f ) -> f32 {
	var q = fract( p * vec2f( 0.1031, 0.1030 ) );
	q += dot( q, q.yx + 33.33 );
	return fract( ( q.x + q.y ) * q.x );
}

struct GroundParcel {
	id: f32,
	edge: f32,
	uv: vec2f,
	size: vec2f,
};

// rotated brick layout, warped by the low frequency fbm so the field edges wander
fn groundParcel( xz: vec2f ) -> GroundParcel {
	let warp = vec2f(
		textureSampleLevel( terrainDetailTex, smpLinearRepeat, xz / 900.0, 0.0 ).w,
		textureSampleLevel( terrainDetailTex, smpLinearRepeat, xz / 900.0 + 0.5, 0.0 ).w ) - 0.5;
	let ca = 0.93; let sa = 0.37; // ~22 degrees off north
	var q = vec2f( ca * xz.x + sa * xz.y, - sa * xz.x + ca * xz.y ) + warp * 70.0;
	let rowH = 62.0;
	let row = floor( q.y / rowH );
	let hr = groundHash( vec2f( row, 17.0 ) );
	let w = 70.0 + hr * 90.0;
	let off = groundHash( vec2f( row, 3.0 ) ) * w;
	let col = floor( ( q.x + off ) / w );
	let lx = q.x + off - col * w;
	let ly = q.y - row * rowH;
	var o: GroundParcel;
	o.id = groundHash( vec2f( col * 1.7 + 11.0, row * 3.1 - 5.0 ) );
	o.edge = min( min( lx, w - lx ), min( ly, rowH - ly ) );
	o.uv = vec2f( lx, ly );
	o.size = vec2f( w, rowH );
	return o;
}

fn groundDryGrass( macroT: f32, detail: f32, slope: f32 ) -> vec3f {
	var c = mix( GC_dryGrass, GC_dryGrassPale, smoothstep( 0.4, 0.65, macroT + ( detail - 0.5 ) * 0.5 ) );
	c = mix( c, GC_greenPlot, smoothstep( 0.42, 0.3, macroT + slope * 0.3 ) * 0.45 );
	return c * ( ( detail - 0.5 ) * 0.25 + 1.0 );
}

// coverage of round crowns of radius r on a square lattice of spacing s (p in lattice metres),
// antialiased by the pixel footprint
fn groundCrowns( p: vec2f, s: f32, r: f32, px: f32 ) -> f32 {
	let cell = floor( p / s );
	let jit = ( vec2f( groundHash( cell ), groundHash( cell + 7.3 ) ) - 0.5 ) * s * 0.25;
	let c = ( cell + 0.5 ) * s + jit;
	let rr = r * ( 0.75 + groundHash( cell + 3.1 ) * 0.5 );
	let d = length( p - c );
	let sharp = 1.0 - smoothstep( rr - px, rr + px, d );
	// far away: the mean cover of the lattice
	let mean = 3.14159 * r * r / ( s * s );
	return mix( sharp, mean, smoothstep( s * 0.15, s * 0.5, px ) );
}

fn groundFarm( xz: vec2f, px: f32, macroT: f32 ) -> vec4f {
	let P = groundParcel( xz );
	let id = P.id;
	let n = textureSampleLevel( terrainDetailTex, smpLinearRepeat, xz / 23.0, 0.0 );
	var col: vec3f;
	var hd = 0.0;
	if ( id < 0.26 ) {
		// stubble: golden, with combine lanes along the rows
		let lane = sin( P.uv.y * 6.2832 / 4.5 ) * 0.5 + 0.5;
		let laneK = 1.0 - smoothstep( 0.6, 2.0, px );
		col = mix( GC_stubble, GC_stubbleLight, smoothstep( 0.3, 0.7, n.w + ( lane - 0.5 ) * 0.3 * laneK ) );
		hd = lane * 0.02 * laneK;
	} else if ( id < 0.44 ) {
		// ploughed: red-brown furrows
		let fur = sin( P.uv.y * 6.2832 / 0.9 ) * 0.5 + 0.5;
		let furK = 1.0 - smoothstep( 0.15, 0.6, px );
		col = mix( GC_plough, GC_ploughRed, smoothstep( 0.35, 0.65, groundHash( vec2f( id * 91.0, 1.0 ) ) + ( n.w - 0.5 ) * 0.6 ) );
		col = mix( col, GC_ploughDark, ( 1.0 - fur ) * 0.45 * furK + ( 1.0 - furK ) * 0.2 );
		hd = fur * 0.12 * furK;
	} else if ( id < 0.6 ) {
		// olive grove on dry grass
		let base = groundDryGrass( macroT, n.w, 0.0 );
		// painted crowns only where a tree is a few pixels across (close up they would read as discs on
		// the ground: the grove's trees are meshes there)
		let cov = groundCrowns( P.uv, 7.0, 2.3, px ) * smoothstep( 0.03, 0.12, px ) * smoothstep( 0.12, 0.35, groundNdV );
		col = mix( base, mix( GC_olive, GC_oliveLight, n.y * 0.6 ), cov );
		hd = cov * 0.15;
	} else if ( id < 0.72 ) {
		// vineyard rows
		let rowP = abs( fract( P.uv.y / 2.6 ) - 0.5 ) * 2.6;
		let rowK = 1.0 - smoothstep( 0.45 - px, 0.45 + px, rowP );
		let far = smoothstep( 0.6, 1.6, px );
		col = mix( GC_vineSoil, GC_vine, mix( rowK, 0.38, far ) );
		hd = rowK * 0.25 * ( 1.0 - far );
	} else if ( id < 0.84 ) {
		// green irrigated plot / pasture
		col = mix( GC_greenPlot, GC_greenLush, smoothstep( 0.35, 0.65, n.w ) );
	} else {
		// fallow: dry grass and weeds
		col = groundDryGrass( macroT, n.w, 0.0 );
		col = mix( col, GC_scrubDry, smoothstep( 0.55, 0.75, n.y ) * 0.5 );
	}
	// a little variation inside each parcel, field margins and the odd hedgerow / farm track
	col = col * ( ( n.w - 0.5 ) * 0.18 + 1.0 ) * ( ( groundHash( vec2f( id * 13.0, 5.0 ) ) - 0.5 ) * 0.14 + 1.0 );
	let edgeW = max( px * 0.7, 1.2 );
	let margin = 1.0 - smoothstep( edgeW * 0.6, edgeW * 2.0, P.edge );
	let kind = groundHash( vec2f( floor( id * 977.0 ), 9.0 ) );
	let marginCol = select( GC_track, GC_hedge, kind < 0.45 );
	col = mix( col, marginCol, margin * 0.75 );
	return vec4f( col, hd + margin * select( 0.0, 0.8, kind < 0.45 ) );
}

fn groundScrub( xz: vec2f, px: f32, macroT: f32, detail: f32 ) -> vec4f {
	let a = textureSampleLevel( terrainDetailTex, smpLinearRepeat, xz / 31.0, 0.0 ).w;
	let b = textureSampleLevel( terrainDetailTex, smpLinearRepeat, xz / 9.0 + 0.3, 0.0 ).w;
	let crowns = smoothstep( 0.4, 0.62, a * 0.6 + b * 0.4 + ( detail - 0.5 ) * 0.3 );
	var col = mix( GC_scrubDry, mix( GC_scrubDark, GC_scrub, smoothstep( 0.45, 0.7, b ) ), crowns );
	col = col * ( ( macroT - 0.5 ) * 0.25 + 1.0 );
	return vec4f( col, crowns * 1.5 );
}

// Irregular cell pattern (jittered-grid Voronoi): x = distance to the nearest centre, y = distance
// to the cell border (approx.), zw = the nearest cell's id. q in cell units.
fn groundVoronoi( q: vec2f ) -> vec4f {
	let cell = floor( q );
	let f = fract( q );
	var d1 = 9.0; var d2 = 9.0; var id = vec2f( 0.0 );
	for ( var j = -1; j <= 1; j++ ) {
		for ( var i = -1; i <= 1; i++ ) {
			let c = cell + vec2f( f32( i ), f32( j ) );
			// (centres jittered only a little and a distance between round and square: squarish setts in
			// loose rows, as the streets' small cubes are laid)
			let o = vec2f( groundHash( c ), groundHash( c + 17.3 ) ) * 0.45 + 0.275;
			let e = vec2f( f32( i ), f32( j ) ) + o - f;
			let d = max( abs( e.x ), abs( e.y ) ) * 0.75 + length( e ) * 0.25;
			if ( d < d1 ) { d2 = d1; d1 = d; id = c; } else if ( d < d2 ) { d2 = d; }
		}
	}
	return vec4f( d1, ( d2 - d1 ) * 0.5, id );
}

// Óbidos street paving: small squarish limestone setts (~0.11 m) and darker ones, set in packed earth;
// fades to the average tone when a stone is smaller than a few pixels
fn groundCobbles( xz: vec2f, px: f32 ) -> vec4f {
	let s = 0.11;
	let v = groundVoronoi( xz / s );
	let h1 = groundHash( v.zw );
	let h2 = groundHash( v.zw + 11.7 );
	var col = mix( GC_settMid, GC_settLight, h1 );
	col = mix( col, GC_settDark, smoothstep( 0.78, 0.92, h2 ) );
	col = mix( col, GC_settWarm, smoothstep( 0.6, 0.85, groundHash( v.zw + 4.4 ) ) * 0.5 );
	let pxS = px / s;
	let joint = 1.0 - smoothstep( 0.03, 0.09 + pxS, v.y );
	let fade = smoothstep( 0.3, 1.0, pxS ); // (the small stones fade before they shimmer into rings)
	let jointCol = mix( GC_joint, GC_track, 0.35 );
	col = mix( mix( col, jointCol, joint * 0.7 ), mix( GC_settMid, jointCol, 0.18 ), fade );
	let dome = smoothstep( 0.0, 0.25, v.y ) * 0.016;
	return vec4f( col, mix( dome - joint * 0.006, 0.0, fade ) );
}
`;

let _module = null;

export function groundShadingModule() {

	return _module || ( _module = new ShaderModule( { name: 'groundShading', deps: [ commonModule, terrainShadingModule() ], code: WGSL } ) );

}
