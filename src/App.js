import { Vector3, Euler, Color, MathUtils } from './engine/index.js';
import { GPU } from './engine/gpu/GPU.js';
import { SunShadows } from './engine/render/Shadows.js';
import { FrameUniforms } from './engine/render/Frame.js';

import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { G } from './core/Globals.js';
import { Profiler } from './core/Profiler.js';
import { SceneRenderer, LAYERS } from './core/SceneRenderer.js';
import { installDebugViews } from './core/DebugViews.js';

import { Atmosphere, SUN_ILLUMINANCE } from './sky/Atmosphere.js';
import { Sky, sunDirectionFromTime } from './sky/Sky.js';
import { Clouds } from './sky/Clouds.js';
import { SkyProClouds } from './sky/SkyProClouds.js';
import { Environment } from './sky/Environment.js';

import { loadDEM } from './world/obidos/Geo.js';
import { TerrainData } from './world/TerrainData.js';
import { TerrainGPU } from './world/TerrainGPU.js';
import { Terrain } from './world/Terrain.js';
import { FarTerrain } from './world/FarTerrain.js';
import { WORLD } from './world/WorldLayout.js';
import { Colliders } from './world/Colliders.js';
import { createTownMaterials } from './world/obidos/TownMaterials.js';
import { Walls } from './world/obidos/Walls.js';
import { Town } from './world/obidos/Town.js';
import { Trees } from './world/obidos/Trees.js';
import { installGroundBounce } from './materials/GroundBounce.js';
import { LocalLights } from './materials/LocalLights.js';
import { AirMotes } from './fx/AirMotes.js';

import { CameraRays } from './post/CameraRays.js';
import { PostFX } from './post/PostFX.js';
import { AirHaze } from './post/AirHaze.js';
import { FlyCamera } from './player/FlyCamera.js';
import { Player } from './player/Player.js';
import { SoundScape } from './audio/SoundScape.js';
import { updateCameraVelocity, useStaticVelocity } from './post/CameraVelocity.js';

const _up = new Vector3( 0, 1, 0 );

// solar declination (degrees) for a day of the year (1 = 1 January)
export function solarDeclination( day ) {

	return - 23.44 * Math.cos( 2 * Math.PI * ( day + 10 ) / 365 );

}

export class App {

	constructor() {

		this.settings = {
			timeOfDay: 17.6, // solar time (hours): 12 = the sun due south
			dayOfYear: 280, // early October
			sunAzimuth: 0, // degrees: turns the sun's daily path about the vertical
			timeSpeed: 0, // hours per real second
			exposure: 0.55,
			renderScale: 1, // internal resolution (the temporal upscaler reconstructs the output), Performance tab
		};
		this.qs = new URLSearchParams( location.search );

	}

	async init( onProgress = () => {} ) {

		const qs = this.qs;
		// report a stage, then let the page paint it before the (synchronous) stage work starts
		const progress = async ( p, text, until ) => {

			onProgress( p, text, until );
			if ( typeof requestAnimationFrame === 'function' ) await new Promise( ( r ) => requestAnimationFrame( () => setTimeout( r, 0 ) ) );

		};
		await progress( 0.02, 'Starting WebGPU…' );
		const engine = this.engine = new Engine( document.getElementById( 'app' ) );
		await engine.init();
		const renderer = engine;
		const { scene, camera } = engine;
		camera.near = 0.1;
		camera.updateProjectionMatrix();
		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;

		this.input = new Input( engine.domElement );
		this.fly = new FlyCamera( camera, engine.domElement, this.input );
		this.fly.setPose( new Vector3( - 160, 95, 0 ), - Math.PI / 2, - 0.12 );

		// ---------------------------------------------------------------- sky
		await progress( 0.04, 'Building the atmosphere…' );
		this.atmosphere = new Atmosphere( renderer );
		this.sky = new Sky( this.atmosphere );
		if ( ! qs.has( 'noClouds' ) ) {

			this.clouds = qs.has( 'oldClouds' ) ? new Clouds( renderer, this.atmosphere ) : new SkyProClouds( renderer, this.atmosphere );
			if ( this.clouds.ready ) await this.clouds.ready;
			this.sky.clouds = this.clouds;

		}

		// 3 cascades: 0-10 m (~1 cm texels, fine contact detail), 10-60 m, 60-400 m (rough far shadows)
		this.csm = this.shadows = new SunShadows( { size: 2048, splits: [ 10, 60, 400 ], lightMargin: 200, normalBias: [ 0.015, 0.06, 0.3 ], bias: 0.00002 } );
		this.shadows.layerMask = ( 1 << LAYERS.OPAQUE ) | ( 1 << LAYERS.TRANSPARENT );

		this.environment = new Environment( renderer, scene, this.sky );

		// ---------------------------------------------------------------- the land
		await progress( 0.06, 'Reading the hills…' );
		this.dem = await loadDEM();
		await progress( 0.1, 'Shaping the ridge…' );
		this.terrainData = new TerrainData( this.dem );
		this.colliders = new Colliders();
		this.terrainGPU = new TerrainGPU( this.terrainData, null );
		this.terrain = new Terrain( { scene, terrainData: this.terrainData, terrainGPU: this.terrainGPU, renderer } );
		this.terrain.mesh.material.appliesHillShadow = true;
		useStaticVelocity( this.terrain.mesh );
		// the land beyond the heightmap, out to the horizon (48 km of the DEM)
		this.farTerrain = new FarTerrain( { scene, dem: this.dem, nearHalf: WORLD.terrainSize / 2 } );
		useStaticVelocity( this.farTerrain.mesh );

		// the walls, towers and gates (walkable wall walk, flights of steps up from the streets)
		await progress( 0.2, 'Raising the walls…' );
		this.townMaterials = createTownMaterials();
		this.walls = new Walls( { scene, terrain: this.terrainData, colliders: this.colliders, materials: this.townMaterials } );
		useStaticVelocity( this.walls.group );
		await progress( 0.26, 'Whitewashing the houses…' );
		this.town = new Town( { scene, terrain: this.terrainData, colliders: this.colliders, materials: this.townMaterials, walls: this.walls } );
		useStaticVelocity( this.town.group );
		if ( ! qs.has( 'noVeg' ) ) {

			await progress( 0.3, 'Planting the cypresses…' );
			this.trees = new Trees( { scene, terrain: this.terrainData, town: this.town, walls: this.walls } );

		}

		// sunlight bounced off the ground (one diffuse bounce, re-baked with the terrain sun shadow)
		installGroundBounce( { terrain: this.terrainGPU, clouds: this.clouds } );
		this.sceneRenderer = new SceneRenderer( engine.meshRenderer, scene, camera );
		if ( this.sky.background ) this.sceneRenderer.background = this.sky.background;
		// lanterns, lit windows and the flashlight (L): nearest few packed into one small uniform array each frame
		this.localLights = new LocalLights();
		for ( const l of [ ...this.town.lights, ...this.walls.lights ] ) this.localLights.add( l );
		this.terrain.mesh.material.localLightsCheap = true;

		// dust, pollen, seed fluff and gnats drifting around the camera
		this.airMotes = new AirMotes( { terrain: this.terrainGPU, clouds: this.clouds, csm: this.csm, reversedDepth: true } );
		scene.add( this.airMotes.mesh );
		// wind, birds and footsteps: field recordings (public/audio, credits in public/audio/CREDITS.md);
		// starts on the first click (see main.js); ?noAudio turns it off
		this.audio = qs.has( 'bench' ) || qs.has( 'noAudio' ) ? null : new SoundScape();
		this.player = new Player( { camera, input: this.input, terrain: this.terrainData, colliders: this.colliders, audio: this.audio } );
		this.freeCam = qs.has( 'fly' );

		// ---------------------------------------------------------------- post
		await progress( 0.34, 'Preparing the shaders…' );
		this.rays = new CameraRays();
		// aerial perspective, haze and volumetric sun shafts (post)
		this.haze = qs.has( 'noHaze' ) ? null : new AirHaze( {
			depthTexture: this.sceneRenderer.sceneRT.depthTexture, rays: this.rays, atmosphere: this.atmosphere,
			sky: this.sky, clouds: this.clouds, terrain: this.terrainGPU, csm: this.csm,
		} );
		this.post = new PostFX( renderer, { sceneRenderer: this.sceneRenderer, camera, rays: this.rays, clouds: this.clouds, sunDir: this.atmosphere.sunDir, haze: this.haze } );
		G.exposure.value = this.settings.exposure;
		if ( qs.has( 'scale' ) ) this.settings.renderScale = Number( qs.get( 'scale' ) ) || 1;
		this.setRenderScale( this.settings.renderScale );

		engine.domElement.addEventListener( 'click', () => {

			if ( window.__ui && window.__ui.isPointerOverUI ) return;
			this.input.requestLock();
			if ( this.audio ) this.audio.resume();

		} );

		this.profiler = new Profiler( renderer );
		this.profiler.track( 'sky view', this.atmosphere.skyViewKernel );

		this.updateSun();
		installDebugViews( this );
		window.__app = this;
		this.gpu = GPU; // console / test access

		// ---- compile pipelines asynchronously (keeps the page responsive), then prime a few
		// frames behind the loading screen so any remaining first-use stalls happen there
		await progress( 0.36, 'Compiling shaders…', 0.95 );
		await this.precompile();
		await progress( 0.96, 'Warming up…' );
		for ( let i = 0; i < 2; i ++ ) {

			this.frame( 1 / 60 );
			await GPU.queue.onSubmittedWorkDone();

		}

	}

	// Build every pipeline up front, then wait for the GPU (keeps first-use compiles behind the loading
	// screen). The precompile frame visits every mesh of every pass, hidden or out of view, and the
	// pipelines compile in parallel in the background (GPU.renderPipeline).
	async precompile() {

		const mr = this.engine.meshRenderer;
		if ( ! this.post._built ) {

			this.post._build();
			this.post._outW = 0; // as PostFX.beginFrame: size the new targets

		}

		await GPU.pipelinesReady();
		mr.precompiling = true;
		try {

			this.frame( 1 / 60 );

		} catch ( e ) {

			console.warn( 'precompile failed', e );

		}

		mr.precompiling = false;
		await GPU.pipelinesReady();
		await GPU.queue.onSubmittedWorkDone();

	}

	// ---------------------------------------------------------------- sun / sky

	updateSun() {

		const s = this.settings;
		const dir = sunDirectionFromTime( s.timeOfDay, WORLD.latitude, solarDeclination( s.dayOfYear ) ).applyAxisAngle( _up, MathUtils.degToRad( s.sunAzimuth || 0 ) );
		// the sky is always scattered sunlight, even with the sun below the horizon (twilight)
		this.atmosphere.sunDir.value.copy( dir );
		// below the horizon the moon takes over as the key light
		const night = MathUtils.smoothstep( - dir.y, 0.02, 0.18 );
		G.night.value = night;
		this.sky.starIntensity.value = night;
		const moon = new Vector3( - dir.x, Math.abs( dir.y ) * 0.8 + 0.25, - dir.z ).normalize();
		this.sky.moonDir.value.copy( moon );
		const light = dir.y > - 0.07 ? dir : moon;
		G.sunDir.value.copy( light );

	}

	applyAtmosphereReadback() {

		const a = this.atmosphere;
		if ( ! a.sunTransmittance ) return;
		const sunTrue = a.sunDir.value;
		const sunUp = sunTrue.y > - 0.07; // same switch as updateSun()
		const T = a.sunTransmittance;
		const horizonFade = MathUtils.smoothstep( sunTrue.y, - 0.03, 0.02 );
		let c;
		if ( sunUp ) c = new Color( T[ 0 ], T[ 1 ], T[ 2 ] ).multiplyScalar( SUN_ILLUMINANCE * horizonFade );
		else c = new Color( 0.6, 0.7, 1.0 ).multiplyScalar( 0.12 * G.night.value );
		G.sunColor.value.copy( c );
		const irr = a.skyIrradiance;
		const nightAmb = 0.012 * G.night.value;
		G.skyIrradiance.value.setRGB( irr[ 0 ] + nightAmb * 0.6, irr[ 1 ] + nightAmb * 0.7, irr[ 2 ] + nightAmb );
		G.horizonColor.value.setRGB( a.horizon[ 0 ], a.horizon[ 1 ], a.horizon[ 2 ] );

	}

	// T: let the day run (about 8 minutes per day) or stop it
	toggleTime() {

		const s = this.settings;
		if ( s.timeSpeed !== 0 ) {

			this._timeSpeed = s.timeSpeed;
			s.timeSpeed = 0;

		} else {

			s.timeSpeed = this._timeSpeed || 0.05;

		}

		if ( this.ui ) {

			this.ui.s.advance = s.timeSpeed !== 0;
			this.ui.ui.refresh();
			this.ui.ui.toast( s.timeSpeed !== 0 ? 'Time running' : 'Time paused' );

		}

	}

	// Free (debug) camera on F; the walker resumes from where the camera is.
	setFreeCam( on ) {

		if ( on === this.freeCam ) return;
		this.freeCam = on;
		if ( on ) {

			const e = new Euler().setFromQuaternion( this.camera.quaternion, 'YXZ' );
			this.fly.setPose( this.camera.position.clone(), e.y, e.x );
			this.fly.velocity.set( 0, 0, 0 );

		} else {

			this.dropPlayerAtCamera();

		}

	}

	// Leaving the free camera: the walker continues from where the camera is, facing the same way,
	// and falls from there onto the ground, a wall walk or a roof.
	dropPlayerAtCamera() {

		const c = this.camera.position;
		const e = new Euler().setFromQuaternion( this.camera.quaternion, 'YXZ' );
		this.player.placeAt( c.x, c.y - 1.62, c.z, e.y, e.x );

	}

	// how exposed the listener is to the wind (the narrow streets are sheltered, the walls and the
	// fields outside are not; high up in the free camera it is all wind) and how many trees are about
	updateAudio( dt ) {

		const c = this.camera.position;
		// re-test the town polygon a few times a second
		this._inTownT = ( this._inTownT || 0 ) - dt;
		if ( this._inTownT <= 0 ) {

			this._inTown = this.terrainData.isInsideTown( c.x, c.z );
			this._inTownT = 0.25;

		}

		const ground = this.terrainData.heightAt( c.x, c.z );
		let exposure, aloft = 0;
		if ( this.freeCam ) {

			aloft = MathUtils.smoothstep( c.y - ground, 8, 60 );
			exposure = 1;

		} else if ( this.player.onWall ) exposure = 1;
		else exposure = this._inTown ? 0.35 : 0.8;
		const trees = this._inTown ? ( this.player.onWall && ! this.freeCam ? 0.6 : 0.4 ) : 1;
		this.audio.update( dt, { camera: this.camera, sunY: this.atmosphere.sunDir.value.y, hour: this.settings.timeOfDay, exposure, trees, aloft, ground } );

	}

	// ---------------------------------------------------------------- loop

	start() {

		this.engine.start( ( dt, t ) => this.frame( dt, t ) );

	}

	updateFPS( dt ) {

		const f = this._fps || ( this._fps = { el: document.getElementById( 'fps' ), acc: 0, n: 0, worst: 0 } );
		f.acc += dt;
		f.n ++;
		f.worst = Math.max( f.worst, dt );
		if ( f.acc >= 0.5 ) {

			const fps = f.n / f.acc;
			let text = `${ fps.toFixed( 0 ) } fps · ${ ( 1000 * f.acc / f.n ).toFixed( 1 ) } ms · max ${ ( f.worst * 1000 ).toFixed( 1 ) } ms`;
			if ( this.profiler && this.profiler.enabled ) {

				const p = this.profiler.result;
				text += ` · GPU c ${ p.compute.toFixed( 2 ) } r ${ p.render.toFixed( 2 ) }`;

			}

			if ( f.el ) f.el.textContent = text;
			this.fps = fps;
			f.acc = 0;
			f.n = 0;
			f.worst = 0;

		}

	}

	frame( dt ) {

		const t0 = performance.now();
		this._frame( dt );
		const ms = performance.now() - t0;
		this.cpuMs = this.cpuMs === undefined ? ms : this.cpuMs * 0.95 + ms * 0.05;

	}

	_frame( dt ) {

		GPU.beginFrame();
		FrameUniforms.fields.frameIndex.value = GPU.frame;
		const s = this.settings;
		this.updateFPS( dt );
		G.dt.value = dt;
		G.time.value += dt;
		if ( s.timeSpeed !== 0 ) s.timeOfDay = ( s.timeOfDay + dt * s.timeSpeed + 24 ) % 24;

		// ---- player
		if ( this.input.hit( 'KeyF' ) ) this.setFreeCam( ! this.freeCam );
		if ( this.input.hit( 'KeyT' ) ) this.toggleTime();
		if ( this.input.hit( 'KeyL' ) ) {

			const on = this.localLights.toggleFlashlight();
			if ( this.ui ) this.ui.ui.toast( on ? 'Flashlight on' : 'Flashlight off' );

		}

		if ( this.input.hit( 'KeyM' ) && this.audio ) {

			const on = this.audio.toggleMute();
			if ( this.ui ) {

				this.ui.ui.refresh();
				this.ui.ui.toast( on ? 'Sound on' : 'Sound off' );

			}

		}

		if ( this.freeCam ) this.fly.update( dt );
		else this.player.update( dt );
		this.updateSun();
		if ( this.audio ) this.updateAudio( dt );

		this.atmosphere.update( dt, this.camera.position.y );
		this.applyAtmosphereReadback();
		this.airMotes.update( dt, this.camera, - 1e4 );
		if ( this.clouds ) this.clouds.update( dt, this.camera );
		this.environment.update( dt );

		// ---- world
		this.terrain.update( this.camera );
		if ( this.farTerrain ) this.farTerrain.update( this.camera );
		this.localLights.update( this.camera, dt );

		// ---- render
		G.exposure.value = s.exposure;
		updateCameraVelocity( this.camera );
		if ( this.post.flare ) {

			this.post.flare.setDepthHeight( this.sceneRenderer.sceneRT.height );
			this.post.flare.update( this.camera, dt, { aboveWater: true } );

		}

		// the post chain sets the TAAU jitter + internal size and writes the camera into the frame
		// uniforms (setFrameCamera); shadows then render with this frame's sun and camera
		this.post.beginFrame();
		this.rays.updateCamera( this.camera );
		this.shadows.render( this.scene, this.engine.meshRenderer, this.shadows.update( this.camera, G.sunDir.value ) );
		this.sceneRenderer.render();
		if ( this.post.flare ) this.post.flare.kernel.dispatch( 1 );
		this.post.render();
		this.post.endFrame();
		GPU.submit();
		this.profiler.update( dt );

		if ( this.ui ) this.ui.update( dt );
		this.input.endFrame();

	}

	// Internal render resolution relative to the output (0.5..1), set by hand: changing it re-creates
	// the scene / post / cloud targets, so nothing adjusts it automatically.
	setRenderScale( v ) {

		const scale = MathUtils.clamp( Math.round( v * 20 ) / 20, 0.5, 1 );
		this.settings.renderScale = scale;
		this.post.setScale( scale );
		if ( this.clouds ) this.clouds.resolutionScale = scale;

	}

}
