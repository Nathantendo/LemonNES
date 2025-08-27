// inputSettings.js
// Browser UI for remapping NES controller inputs

import Input from "./input.js";  // assumes input.js is in same folder

const input = new Input(); // The same class used by your emulator
let waitingForRemap = null; // {player, button, element}

document.querySelectorAll("button[data-player]").forEach((btn) => {
    btn.addEventListener("click", () => {
        const player = parseInt(btn.dataset.player, 10);
        const buttonName = btn.dataset.btn;
        const label = document.getElementById(`p${player}-${buttonName}`);

        waitingForRemap = { player, button: buttonName, element: label };

        // Highlight the waiting button
        btn.classList.add("waiting");
        btn.textContent = "Press key or gamepad button...";
    });
});

// Keyboard listener
window.addEventListener("keydown", (e) => {
    if (waitingForRemap) {
        const { player, button, element } = waitingForRemap;

        // Update UI
        element.textContent = e.code;

        // Update mapping
        const newMap = { ...getPlayerKeyMap(player), [e.code]: button };
        input.remapPlayerKey(player, newMap);

        finishRemap();
    }
});

// Gamepad polling for remapping
function pollGamepads() {
    if (waitingForRemap) {
        const gpList = navigator.getGamepads();
        for (let gp of gpList) {
            if (!gp) continue;

            // Look for pressed button
            for (let i = 0; i < gp.buttons.length; i++) {
                if (gp.buttons[i].pressed) {
                    const { player, button, element } = waitingForRemap;
                    element.textContent = `Gamepad${gp.index}-Btn${i}`;

                    const newMap = { ...getPlayerGamepadMap(player), [button]: i };
                    input.remapPlayerGamepad(player, newMap);

                    finishRemap();
                    return;
                }
            }
        }
    }
    requestAnimationFrame(pollGamepads);
}
pollGamepads();

function finishRemap() {
    // Reset waiting state
    document.querySelectorAll("button.waiting").forEach((b) => {
        b.classList.remove("waiting");
        b.textContent = "Remap";
    });
    waitingForRemap = null;
}

function getPlayerKeyMap(player) {
    return player === 1 ? input.player1.keyMap : input.player2.keyMap;
}

function getPlayerGamepadMap(player) {
    return player === 1 ? input.player1.gamepadMap : input.player2.gamepadMap;
}
