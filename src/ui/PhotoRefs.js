import { GPU } from '../engine/gpu/GPU.js';
import { Texture } from '../engine/gpu/Texture.js';
import { readTexture } from '../engine/gpu/Readback.js';

// Reference photos: a photo taken in the real Óbidos laid over the game view (R), so the camera can be
// lined up with it, then saved with the view it was matched from. Saving needs the dev server (npm run
// dev): it writes references/<when>-<name>/ with the photo, the game's image of the same view and
// view.json (camera position, yaw, pitch, field of view, time of day). ?ref=<folder> opens a saved one
// again: the same view, the photo over it.
export class PhotoRefs {

	constructor( app, ui ) {

		this.app = app;
		this.ui = ui;
		this.file = null; // the photo as chosen (saved as is)
		this.photoSize = null;
		this.opacity = 0.5;
		this.open = false;

		this.overlay = el( 'div', 'tw-ref-overlay' );
		this.img = el( 'img', '', { alt: '' } );
		this.overlay.append( this.img );
		this.overlay.hidden = true;

		this.panel = el( 'div', 'tw-ref-panel tw-interactive' );
		this.panel.hidden = true;
		this.panel.innerHTML = `
			<div class="tw-ref-head"><b>Reference photo</b><button type="button" class="tw-ref-close" title="Close (R)">×</button></div>
			<p class="tw-ref-hint">Choose a photo (or drop it on the game), stand where it was taken and line the game up with it (click the game to look around, Esc to come back here). Then save.</p>
			<label class="tw-ref-btn">Choose photo…<input type="file" accept="image/*" hidden></label>
			<label class="tw-ref-row"><span>Photo opacity</span><input type="range" min="0" max="1" step="0.05" data-k="opacity"></label>
			<label class="tw-ref-row"><span>Field of view <output></output></span><input type="range" min="25" max="100" step="1" data-k="fov"></label>
			<label class="tw-ref-row"><span>Name</span><input type="text" placeholder="e.g. porta da vila steps" maxlength="60"></label>
			<label class="tw-ref-row"><span>Note</span><input type="text" placeholder="what to look at (optional)" maxlength="300" data-k="note"></label>
			<button type="button" class="tw-ref-btn tw-ref-save">Save view</button>
			<p class="tw-ref-status" aria-live="polite"></p>`;
		const q = ( s ) => this.panel.querySelector( s );
		this.fileInput = q( 'input[type=file]' );
		this.opacityInput = q( '[data-k=opacity]' );
		this.fovInput = q( '[data-k=fov]' );
		this.fovOut = q( 'output' );
		this.nameInput = q( 'input[type=text]:not([data-k])' );
		this.noteInput = q( '[data-k=note]' );
		this.status = q( '.tw-ref-status' );
		this.saveBtn = q( '.tw-ref-save' );

		q( '.tw-ref-close' ).addEventListener( 'click', () => this.toggle( false ) );
		this.fileInput.addEventListener( 'change', () => this.fileInput.files[ 0 ] && this.setPhoto( this.fileInput.files[ 0 ] ) );
		this.opacityInput.addEventListener( 'input', () => this.setOpacity( + this.opacityInput.value ) );
		this.fovInput.addEventListener( 'input', () => this.setFov( + this.fovInput.value ) );
		this.saveBtn.addEventListener( 'click', () => this.save() );
		// the panel takes the clicks, not the game behind it
		this.panel.addEventListener( 'mousedown', ( e ) => e.stopPropagation() );

		// the photo under the interface; the panel in it, over the HUD and under the start screen and help
		document.body.append( this.overlay );
		ui.root.append( this.panel );

		window.addEventListener( 'keydown', ( e ) => {

			if ( e.code !== 'KeyR' || e.repeat || e.ctrlKey || e.metaKey || e.altKey ) return;
			if ( /^(INPUT|TEXTAREA|SELECT)$/.test( e.target.tagName ) || e.target.isContentEditable ) return;
			this.toggle();

		} );
		// out of the way while the mouse looks around (lining up), back on Esc
		document.addEventListener( 'pointerlockchange', () => this.panel.classList.toggle( 'is-looking', !! document.pointerLockElement ) );
		// a photo dropped anywhere on the game
		window.addEventListener( 'dragover', ( e ) => e.preventDefault() );
		window.addEventListener( 'drop', ( e ) => {

			const f = [ ...( e.dataTransfer?.files || [] ) ].find( ( f ) => f.type.startsWith( 'image/' ) );
			if ( ! f ) return;
			e.preventDefault();
			this.toggle( true );
			this.setPhoto( f );

		} );

		if ( ! import.meta.env.DEV ) {

			this.saveBtn.disabled = true;
			this.say( 'Saving works when the game runs on your computer (npm run dev).' );

		}

		const ref = app.qs.get( 'ref' );
		if ( ref ) this.load( ref );

	}

	toggle( on = ! this.open ) {

		this.open = on;
		this.panel.hidden = ! on;
		this.overlay.hidden = ! on || ! this.img.src;
		if ( on ) {

			this.opacityInput.value = this.opacity;
			this.fovInput.value = Math.round( this.app.camera.fov );
			this.fovOut.textContent = Math.round( this.app.camera.fov ) + '°';

		}

	}

	setPhoto( file ) {

		this.file = file;
		if ( this.img.src.startsWith( 'blob:' ) ) URL.revokeObjectURL( this.img.src );
		this.img.onload = () => {

			this.photoSize = [ this.img.naturalWidth, this.img.naturalHeight ];
			this.overlay.hidden = ! this.open;
			// a phone's main camera sees about 70° across its long side: start there
			const portrait = this.img.naturalHeight > this.img.naturalWidth;
			this.setFov( portrait ? 70 : 50 );
			if ( ! this.nameInput.value ) this.nameInput.value = file.name.replace( /\.[^.]+$/, '' );
			this.say( 'Move the camera until the game lines up with the photo.' );

		};
		this.img.onerror = () => this.say( 'This photo can\'t be shown here. Try saving it as JPEG first (iPhone photos are often HEIC).' );
		this.img.src = URL.createObjectURL( file );

	}

	setOpacity( v ) {

		this.opacity = v;
		this.img.style.opacity = v;

	}

	// the photo is shown full height, so the camera's (vertical) field of view is the photo's
	setFov( v ) {

		const app = this.app;
		app.camera.fov = v;
		app.camera.updateProjectionMatrix();
		if ( app.ui ) app.ui.s.fov = v; // the settings panel's Field of view
		this.fovInput.value = v;
		this.fovOut.textContent = Math.round( v ) + '°';

	}

	// the current view as numbers (the camera, whichever of the walker or the free camera has it)
	pose() {

		const c = this.app.camera;
		const e = [ - c.matrixWorld.elements[ 8 ], - c.matrixWorld.elements[ 9 ], - c.matrixWorld.elements[ 10 ] ];
		const r = ( v, d = 100 ) => Math.round( v * d ) / d;
		return {
			position: [ r( c.position.x ), r( c.position.y ), r( c.position.z ) ],
			yaw: r( Math.atan2( - e[ 0 ], - e[ 2 ] ), 1000 ),
			pitch: r( Math.asin( Math.max( - 1, Math.min( 1, e[ 1 ] ) ) ), 1000 ),
			fov: r( c.fov, 10 ),
			timeOfDay: r( this.app.settings.timeOfDay ),
			freeCamera: this.app.freeCam,
		};

	}

	async save() {

		if ( ! this.file ) return this.say( 'Choose a photo first.' );
		this.saveBtn.disabled = true;
		this.say( 'Saving…' );
		try {

			const view = this.pose();
			const game = await this.capture();
			const body = {
				name: this.nameInput.value.trim() || 'photo',
				note: this.noteInput.value.trim(),
				view,
				photoSize: this.photoSize,
				opacity: this.opacity,
				photo: { type: this.file.type, data: await dataURL( this.file ) },
				game: { type: 'image/jpeg', data: await dataURL( game ) },
			};
			const res = await fetch( '/__refs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify( body ) } );
			if ( ! res.ok ) throw new Error( await res.text() );
			const { folder } = await res.json();
			this.say( `Saved as references/${ folder }` );
			this.ui.toast( 'Reference photo saved' );

		} catch ( e ) {

			console.error( e );
			this.say( 'Could not save: ' + e.message );

		} finally {

			this.saveBtn.disabled = ! import.meta.env.DEV;

		}

	}

	// the game's image of the current view, without the interface or the photo: one frame drawn into a
	// texture of our own instead of the screen, read back
	async capture() {

		const app = this.app, canvas = app.engine.canvas;
		const { width, height } = canvas;
		if ( ! this._out || this._out.width !== width || this._out.height !== height ) this._out = new Texture( { width, height, format: GPU.format, usage: [ 'render', 'copySrc', 'sample' ], label: 'reference capture' } );
		app.post.outputTexture = this._out;
		try {

			await frames( 2 );
			const img = await readTexture( this._out );
			const px = new Uint8ClampedArray( img.data );
			if ( GPU.format.startsWith( 'bgra' ) ) for ( let i = 0; i < px.length; i += 4 ) [ px[ i ], px[ i + 2 ] ] = [ px[ i + 2 ], px[ i ] ];
			for ( let i = 3; i < px.length; i += 4 ) px[ i ] = 255;
			const oc = new OffscreenCanvas( img.width, img.height );
			oc.getContext( '2d' ).putImageData( new ImageData( px, img.width, img.height ), 0, 0 );
			return await oc.convertToBlob( { type: 'image/jpeg', quality: 0.9 } );

		} finally {

			app.post.outputTexture = null;

		}

	}

	// ?ref=<folder>: back to a saved view, its photo over the game
	async load( folder ) {

		try {

			const base = `/references/${ encodeURIComponent( folder ) }/`;
			const res = await fetch( base + 'view.json' );
			// a missing folder comes back as the game's page, not as JSON
			if ( ! ( res.headers.get( 'content-type' ) || '' ).includes( 'json' ) ) throw new Error( 'no references/' + folder + '/view.json' );
			const v = await res.json();
			const app = this.app, p = v.view;
			app.settings.timeOfDay = p.timeOfDay;
			app.settings.timeSpeed = 0;
			app.setFreeCam( true );
			app.fly.setPose( app.camera.position.clone().set( ...p.position ), p.yaw, p.pitch );
			app.fly.velocity.set( 0, 0, 0 );
			this.nameInput.value = v.name;
			this.noteInput.value = v.note || '';
			this.setOpacity( v.opacity ?? 0.5 );
			const blob = await ( await fetch( base + v.photoFile ) ).blob();
			this.setPhoto( new File( [ blob ], v.photoFile, { type: blob.type } ) );
			this.toggle( true );
			this.img.addEventListener( 'load', () => this.setFov( p.fov ), { once: true } );

		} catch ( e ) {

			console.error( e );
			this.toggle( true );
			this.say( `Could not open references/${ folder }` );

		}

	}

	say( text ) {

		this.status.textContent = text;

	}

}

function el( tag, cls, attrs = {} ) {

	const e = document.createElement( tag );
	if ( cls ) e.className = cls;
	for ( const k in attrs ) e.setAttribute( k, attrs[ k ] );
	return e;

}

function dataURL( blob ) {

	return new Promise( ( resolve, reject ) => {

		const r = new FileReader();
		r.onload = () => resolve( r.result );
		r.onerror = () => reject( r.error );
		r.readAsDataURL( blob );

	} );

}

function frames( n ) {

	return new Promise( ( resolve ) => {

		const step = () => ( -- n <= 0 ? resolve() : requestAnimationFrame( step ) );
		requestAnimationFrame( step );

	} );

}
