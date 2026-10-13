import { defineConfig } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Reference photos (src/ui/PhotoRefs.js): the dev server saves what the game posts to /__refs into
// references/<when>-<name>/ (the photo, the game's image of the same view, view.json). Dev only.
function references() {

	const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif' };
	return {
		name: 'castelo-references',
		apply: 'serve',
		configureServer( server ) {

			server.middlewares.use( '/__refs', ( req, res ) => {

				if ( req.method !== 'POST' ) {

					res.statusCode = 405;
					return res.end();

				}

				const chunks = [];
				req.on( 'data', ( c ) => chunks.push( c ) );
				req.on( 'end', async () => {

					try {

						const b = JSON.parse( Buffer.concat( chunks ).toString() );
						const d = new Date(), two = ( n ) => String( n ).padStart( 2, '0' ); // local time, as on the photo
						const when = `${ d.getFullYear() }-${ two( d.getMonth() + 1 ) }-${ two( d.getDate() ) }-${ two( d.getHours() ) }${ two( d.getMinutes() ) }`;
						// a folder name: no accents, lowercase words joined by '-'
						const slug = String( b.name || 'photo' ).toLowerCase().normalize( 'NFD' ).replace( /[\u0300-\u036f]/g, '' ).replace( /[^a-z0-9]+/g, '-' ).replace( /^-|-$/g, '' ).slice( 0, 40 ) || 'photo';
						const folder = `${ when }-${ slug }`;
						const dir = resolve( 'references', folder );
						await mkdir( dir, { recursive: true } );
						const bytes = ( d ) => Buffer.from( d.split( ',' )[ 1 ], 'base64' );
						const photoFile = 'photo.' + ( EXT[ b.photo.type ] || 'jpg' );
						await writeFile( resolve( dir, photoFile ), bytes( b.photo.data ) );
						await writeFile( resolve( dir, 'game.jpg' ), bytes( b.game.data ) );
						const view = { name: b.name, note: b.note, savedAt: new Date().toISOString(), view: b.view, photoFile, gameFile: 'game.jpg', photoSize: b.photoSize, opacity: b.opacity };
						await writeFile( resolve( dir, 'view.json' ), JSON.stringify( view, null, '\t' ) + '\n' );
						res.setHeader( 'content-type', 'application/json' );
						res.end( JSON.stringify( { folder } ) );

					} catch ( e ) {

						res.statusCode = 500;
						res.end( e.message );

					}

				} );

			} );

		},
	};

}

export default defineConfig( {
	// relative asset paths: the build runs from any sub-path (GitHub Pages serves it under /tidewater/)
	base: './',
	build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
	server: { port: 5188, strictPort: true, host: '127.0.0.1' },
	plugins: [ references() ],
} );
