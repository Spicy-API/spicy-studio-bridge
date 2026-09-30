# Third-party software

SpicyAPI Studio Bridge is MIT licensed. Its runtime uses the official Model Context Protocol
server and core packages (2.0.0, MIT) and Zod (4.5.4, MIT). Their original LICENSE files and package
metadata remain in the release ZIP under runtime/node_modules/. Upstream runtime translations
remain unchanged. No source code from competing bridge projects was copied.

Development-only dependencies are listed in package-lock.json and are not bundled for end users.
The desktop bundle omits source maps and Zod source-test directories; it retains all runtime module
formats, source export paths, type declarations, documentation and licenses.
