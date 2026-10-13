# Course expansion motion

Research and local frame inspection, October 12, 2026. The goal is a continuous card-to-detail transition: shared artwork stays visible and changes bounds with the container; changed content fades between states.

## Comparable implementations

| Example | Relevant behavior | Application here |
| --- | --- | --- |
| [Material container transform](https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md#container-transform) | Transforms a container's bounds and shape while controlling its content fade separately. | Animate corners and shadow through the final handoff; separate spatial movement from content opacity. |
| [Android shared elements](https://developer.android.com/develop/ui/compose/animation/shared-elements) and [Jetsnack source](https://github.com/android/compose-samples/blob/main/Jetsnack/app/src/main/java/com/example/jetsnack/ui/snackdetail/SnackDetail.kt) | Distinguish identical shared content from differently rendered content in shared bounds. Jetsnack matches image/title while other details enter separately. Text remeasurement can change wrapping; image crop modes need deliberate handling. | Keep one opaque artwork layer; match its bounds. Typography and new details need separate treatment. |
| [Motion shared layout](https://motion.dev/docs/react-layout-animations) and [App Store example](https://examples.motion.dev/react/app-store) | Matching identities connect endpoints; overlapping matched instances can crossfade. Layout animation supports interruption, but transformed children need distortion correction. | Retarget from the displayed state when closing early. Do not scale all live card content as a single bitmap. |
| [Chrome image expansion example](https://simple-vt-demos.jakearchibald.com/7-expanding-image-ratio/) and [source](https://github.com/jakearchibald/simple-vt-demos/blob/main/public/7-expanding-image-ratio/styles.css) | Disables the default image crossfade and uses directional crop behavior to avoid blending differently cropped copies. | Identical artwork should morph without disappearing or producing two crops. Use fades for actual differences. |
| [Apple zoom transitions](https://developer.apple.com/videos/play/wwdc2024/10145/) | Connects a source view to a destination and supports continuously interrupted transitions. | Early dismissal must begin from the current geometry, appearance, and opacity. |
| [Svelte deferred transitions](https://svelte.dev/tutorial/svelte/deferred-transitions) | Matches outgoing and incoming elements by key, with fallback content transitions. | Identity and endpoint lifetime matter more than the framework used. |

## Local evidence and decisions

Chrome screencast frames of the actual expansion component showed the previous 420 ms spring covering roughly 90% of the desktop header-width change by 80 ms. It overshot shortly afterward and appeared nearly stationary from 240 ms through completion. The artwork remained present; the rapid geometry and crop change was the main visible defect in that fixture.

Use a course-specific response so that bounds and matching styles share one motion clock, retaining a modest settle while spreading movement across the transition. Leave widget resize motion independent. Changed content gets a short opacity overlap instead of blur or a gap where both states disappear. Identical artwork stays opaque. Differing background treatments must blend inside the same moving bounds rather than switch discretely.

Text needs a stricter size boundary than the shell: overshooting an intrinsic title width can wrap a word into a clipped extra line. Keep one-line title sizes within their endpoints while their position follows the spring. When expansion reveals additional title lines, treat that changed layout as fading content instead of continuously remeasuring it into a shrinking clipping box. When the expanded heading adds a course-code prefix, fade the whole heading together so a separately moving name cannot overlap the prefix during the spring settle.

Keep the current interruptible Web Animations implementation. Native View Transitions are a useful visual reference, but switching engines would change interruption behavior and broaden this fix. No framework upgrade or animation dependency is required.

Keep expanded content laid out at the destination's inner dimensions while the opening shell animates, then release those dimensions at handoff. This prevents intermediate flex reflow from moving the live labels away from their measured morph endpoints. Instructor and credit labels crossfade with their respective layouts: their compact inline row and expanded sections are different content arrangements, not shared spatial slots. Decorative watermark clones stay with the background artwork below the detail-content stacking context, including the close button.

The destination-sized detail layout needs its own horizontal position compensation while the shell moves. Use the same spring progress as the shell to keep the detail layout's world-left at the measured destination throughout opening; this lets the shell and opaque shared artwork grow from the source without dragging the live detail layout across the viewport. On close, hold the captured live world-left while the shell returns, keeping the full detail layout from reflowing into the shrinking shell as it fades. Capture that left edge before retargeting a resize and interpolate it to the new destination so the first frame remains continuous. This follows the shared-layout principle in [Motion's layout animation guide](https://motion.dev/docs/react-layout-animations) while keeping content opacity on its separate shorter clock.

## Verification

Inspect rendered opening and closing frames on desktop and mobile, including long titles, portrait/landscape artwork, gradient-only headers, early dismissal, delayed image decoding, resize, and reduced motion. Confirm a continuous image, aligned endpoints, no duplicated shared content, and no corner/shadow snap. Unit tests support these checks but cannot establish perceived smoothness alone.

Browser checks use the actual component and application styles with locally authored landmark SVGs, not private course photographs. Both system and app reduced-motion settings must restore the source immediately; disabling transitions on class-card descendants prevents the global reduced-duration rule from inadvertently animating inherited visibility.
