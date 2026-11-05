import { Mesh, Vector3 } from '../engine/index.js';
import { ShaderModule } from '../engine/gpu/Shader.js';
import { CDLOD } from '../core/CDLOD.js';
import { standard } from '../materials/Materials.js';
import { G } from '../engine/render/Frame.js';
import { srgb, rot2, terrainShadingModule } from './terrain/TerrainShading.js';
import { groundShadingModule } from './terrain/GroundShading.js';

// The former TerrainLightingModel (multiplies the key directional light by the soft heightfield
// sun shadow: long hill shadows beyond the shadow map range and from terrain outside the view) is
// `terrainGPU.sunModulationModule` + the define MATERIAL_SUN_MODULATION (see TerrainGPU.js); the
// terrain's own version below also darkens the tall-grass meadow at low sun.

// Óbidos terrain: CDLOD mesh displaced by the heightmap, with a procedural material for the town and
// the countryside around it: limestone setts in the streets, dusty town ground, the field patchwork of
// the Várzea (stubble, ploughed earth, olive groves, vineyards, green plots, fallow; GroundShading),
// Mediterranean scrub on the uncultivated slopes, asphalt roads, farm tracks and bare limestone on the
// steepest ground. Detail comes from one small tileable height texture sampled at several scales;
// normals use surface-gradient bump mapping; the baked horizon AO feeds the surface ao. The key light
// is multiplied by the baked heightfield sun shadow (long, soft hill shadows at low sun).
export class Terrain {

	// gridSize 40 / rangeFactor 2.0: 0.2 m vertices at the camera, ~80 quads per LOD range
	// (~9-25 % finer than 32 / 2.3 at every distance) for 0.1-0.2 M triangles.
	// sunShadow: apply the heightfield sun shadow here (pass false if it is applied to every scene
	// material through SceneLighting.directModulation). renderer: optional (unused: the sun shadow
	// map is baked from update() into the frame encoder).
	constructor( { scene, terrainData, terrainGPU, gridSize = 40, rangeFactor = 2.0, sunShadow = true, renderer = null } ) {

		this.data = terrainData;
		this.gpu = terrainGPU;
		const half = terrainData.size / 2;

		this.lod = new CDLOD( {
			gridSize, leafSize: 8, levels: 9,
			heightBounds: ( x0, z0, x1, z1 ) => terrainData.boundsFor( x0, z0, x1, z1 ),
			center: { x: - half, z: - half, size: terrainData.size },
			rangeFactor,
			prefix: 'terrainLod',
		} );

		this.sunShadow = sunShadow;
		this.renderer = renderer;

		// Morph toward the view camera in every pass: the shadow passes render the same surface
		// (with the pass camera they would morph toward the light camera instead).
		this.uViewPos = { value: new Vector3() };

		const mat = this.material = standard( {
			name: 'Terrain',
			roughness: 0.9, metalness: 0,
			uniforms: {
				viewPos: [ 'vec3f', this.uViewPos.value ],
			},
			attributes: { nodeData: 'vec4f' },
		} );
		this.uViewPos = mat.uniforms.viewPos;

		mat.vertex = /* wgsl */`
	// CDLOD vertex (same lattice snapping and geomorph as the CDLOD module) morphing toward viewPos
	let snapped = terrainLodSnapped( v.nodeData, v.position.xz );
	let y0 = terrainHeightAt( snapped );
	let cv = terrainLodMorph( v.nodeData, v.position.xz, mat.viewPos, y0 );
	v.useWorld = true;
	v.worldPos = vec3f( cv.worldXZ.x, terrainHeightAt( cv.worldXZ ), cv.worldXZ.y );
	v.worldNormal = vec3f( 0.0, 1.0, 0.0 );
`;

		this.finalizeMaterial();

		this.mesh = new Mesh( this.lod.geometry, mat );
		this.mesh.frustumCulled = false;
		this.mesh.receiveShadow = true;
		this.mesh.castShadow = true;
		this.mesh.staticVelocity = true;
		this.mesh.name = 'Terrain';
		scene.add( this.mesh );

	}

	// (Re)build the fragment code.
	finalizeMaterial() {

		const mat = this.material;
		const modules = [ this.gpu.module, terrainShadingModule(), this.lod.module ];
		modules.push( groundShadingModule() );
		modules.push( new ShaderModule( { name: 'terrainMaterial', deps: [ this.gpu.module, terrainShadingModule(), groundShadingModule() ], code: TERRAIN_MATERIAL_WGSL } ) );
		mat.modules = modules;
		mat.defines.MATERIAL_SUN_MODULATION = this.sunShadow ? 1 : 0;
		mat.surface = TERRAIN_SURFACE;
		mat.needsUpdate = true;

	}

	update( camera ) {

		camera.getWorldPosition( this.uViewPos.value );
		this.lod.update( camera );
		this.gpu.updateSunShadow( this.renderer );

	}

}

const S = srgb;

const TERRAIN_MATERIAL_WGSL = /* wgsl */`
fn materialSunModulation( P: vec3f, N: vec3f ) -> vec3f {
	return vec3f( terrainSunShadowAt( P ) );
}

fn terDetail( uv: vec2f ) -> vec4f {
	return textureSample( terrainDetailTex, smpAniso4Repeat, uv );
}
`;

const TERRAIN_SURFACE = /* wgsl */`
	let p = in.P;
	let xz = p.xz;
	let h = p.y;

	// ---- data maps
	let nr = terrainNormalRock( xz );
	let N0 = normalize( vec3f( nr.x, sqrt( max( 1.0 - nr.x * nr.x - nr.y * nr.y, 0.0025 ) ), nr.y ) );
	let sp = terrainSplat( xz ); // farmland, paved, scrub, town
	let slope = 1.0 - N0.y;
	let camDist = length( frame.cameraPos - p );
	let dpx = dpdx( p ); let dpy = dpdy( p );
	let fwY = fwidth( h );
	let px = max( length( dpx ), length( dpy ) ); // pixel footprint (m)

	// ---- detail samples (uniform control flow)
	let macroA = terDetail( ${ rot2( 'xz', 0.7 ) } / 173.0 ).w;
	let macroB = terDetail( ${ rot2( 'xz', 2.1 ) } / 47.0 ).w;
	let mcr = macroA * 0.6 + macroB * 0.4;
	let dN = terDetail( xz / 1.9 );
	let dM = terDetail( ${ rot2( 'xz', 1.3 ) } / 6.7 + 0.21 );
	let dF = terDetail( ${ rot2( 'xz', 2.4 ) } / 0.63 + 0.53 );

	// ---- rough ground: dry grass with green in the hollows, bare soil showing through
	var ground = groundDryGrass( mcr, dM.w * 0.6 + dN.w * 0.4, slope );
	ground = mix( ground, ${ S( 0.55, 0.45, 0.33 ) } * ( dN.y * 0.3 + 0.85 ), smoothstep( 0.6, 0.78, dN.y + ( dM.y - 0.5 ) * 0.5 ) * 0.5 );
	var hd = dN.y * 0.04 + dF.y * 0.012 + dM.y * 0.05;

	// ---- farmland patchwork
	groundNdV = sat( dot( N0, normalize( frame.cameraPos - p ) ) );
	let farmW = smoothstep( 0.25, 0.7, sp.x + ( dM.w - 0.5 ) * 0.3 );
	if ( farmW > 0.0 ) {
		let fm = groundFarm( xz, px, mcr );
		ground = mix( ground, fm.rgb, farmW );
		hd = mix( hd, fm.a + dF.y * 0.01, farmW );
	}

	// ---- scrub and woodland
	let scrubW = smoothstep( 0.3, 0.7, sp.z + ( dM.w - 0.5 ) * 0.4 + ( macroB - 0.5 ) * 0.3 );
	if ( scrubW > 0.0 ) {
		let sc = groundScrub( xz, px, mcr, dN.w );
		ground = mix( ground, sc.rgb, scrubW );
		hd = mix( hd, sc.a, scrubW );
	}

	// ---- town ground: dusty beaten earth and stone, weeds along the edges
	let townW = smoothstep( 0.35, 0.75, sp.w );
	var townCol = mix( ${ S( 0.6, 0.56, 0.48 ) }, ${ S( 0.68, 0.64, 0.56 ) }, dM.w ) * ( ( dN.y - 0.45 ) * 0.25 + 1.0 );
	townCol = mix( townCol, ${ S( 0.35, 0.38, 0.2 ) }, smoothstep( 0.6, 0.75, dM.w + ( dN.w - 0.5 ) * 0.4 ) * 0.4 );
	ground = mix( ground, townCol, townW );
	hd = mix( hd, dN.z * 0.02 + dM.x * 0.03, townW );

	// ---- streets: limestone setts in the town, asphalt roads outside, earth farm tracks
	let pavedW = smoothstep( 0.62, 0.85, sp.y );
	let trackW = smoothstep( 0.2, 0.42, sp.y ) * ( 1.0 - pavedW );
	let cob = groundCobbles( xz, px );
	let townish = smoothstep( 0.2, 0.5, sp.w );
	var asphalt = mix( ${ S( 0.2, 0.2, 0.2 ) }, ${ S( 0.27, 0.26, 0.25 ) }, dM.w ) * ( ( dF.z - 0.5 ) * 0.2 + 1.0 );
	let paved = mix( asphalt, cob.rgb, townish );
	let pavedHd = mix( dF.z * 0.004, cob.a, townish );
	var track = ${ S( 0.66, 0.57, 0.43 ) } * ( ( dN.y - 0.45 ) * 0.3 + 1.0 );
	ground = mix( ground, track, trackW * 0.85 );
	hd = mix( hd, dN.z * 0.015, trackW );
	ground = mix( ground, paved, pavedW );
	hd = mix( hd, pavedHd, pavedW );
	// weeds in the setts' joints where the scrub mask is over 0.86 on the town's paving (the feet of a few walls)
	// (fewer, in patches, toward the edge of the mask)
	let weedM = smoothstep( 0.86, 1.0, sp.z );
	let weedW = weedM * pavedW * townish * smoothstep( 0.62 - 0.27 * weedM, 0.8 - 0.2 * weedM, dN.w + ( dF.w - 0.5 ) * 0.8 );
	ground = mix( ground, ${ S( 0.24, 0.36, 0.1 ) } * ( dF.y * 0.5 + 0.75 ), weedW * 0.7 );

	// ---- bare limestone
	var rockW = 0.0;
	var rockAlbedo = vec3f( 0.5 ); var rockRough = 0.85; var rockHd = 0.0;
	if ( nr.z > 0.04 ) {
		var g: RockGrad;
		g.dpdx = dpx; g.dpdy = dpy; g.fwY = fwY; g.useGrad = true;
		let R = terrainRockSurface( p, N0, h, mcr, 0.5, 0.4, g );
		let rv = nr.z * 0.9 + ( R.height - 0.45 ) * 0.4 + ( dM.w - 0.5 ) * 0.3 + ( dN.w - 0.5 ) * 0.2;
		rockW = smoothstep( 0.45, 0.62, rv ) * ( 1.0 - pavedW );
		rockAlbedo = R.albedo;
		rockRough = R.rough;
		rockHd = R.hd * 2.0 + R.height * 0.5;
	}
	var albedo = mix( ground, rockAlbedo, rockW );
	hd = mix( hd, rockHd, rockW );
	var rough = mix( 0.9, 0.8, pavedW * townish );
	rough = mix( rough, rockRough, rockW );

	let aoDetail = mix( 1.0, dN.y * 0.4 + 0.75, scrubW );
	s.albedo = albedo;
	s.roughness = rough;
	s.normal = terrainPerturbNormal( p, N0, hd, 1.0 );
	s.ao = sat( nr.w * aoDetail );
`;
