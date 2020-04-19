/* leny/zoondo
 *
 * /src/server/game/index.js - Game classes - main class
 *
 * coded by leny
 * started at 10/04/2020
 */

/* eslint-disable no-console */

import tribes from "data/tribes";
import {sendSystemMessage} from "core/socket";
import {resolveMoves, resolveCard} from "data/utils";
import cloneDeep from "lodash.clonedeep";
import {ACTIONS} from "data/constants";

export default class Game {
    server = null;
    room = null;
    players = {};
    stack = [];
    turn = {
        count: 0,
        activePlayer: null,
        phase: "waiting",
        combat: null,
        action: null,
        timer: 30,
    };
    board = [];
    supports = [];
    trumps = [];
    graveyard = [];

    constructor(server, roomId, firstPlayer) {
        this.server = server;
        this.room = roomId;
        this.players[firstPlayer.id] = {...firstPlayer, isFirstPlayer: true};
        const tribe = tribes.get(firstPlayer.tribe);
        Array.from(tribe.disposition)
            .reverse()
            .forEach((row, y) =>
                row.forEach((slug, x) =>
                    this.board.push({
                        player: firstPlayer.id,
                        x,
                        y,
                        card: {
                            tribe: firstPlayer.tribe,
                            type: "fighters",
                            slug,
                        },
                    }),
                ),
            );
        this._sendMessage("Partie créée. En attente d'un second joueur…");
        this._sendState();
    }

    join(secondPlayer) {
        this.players[secondPlayer.id] = {...secondPlayer, isFirstPlayer: false};
        const tribe = tribes.get(secondPlayer.tribe);
        Array.from(tribe.disposition)
            .reverse()
            .forEach((row, y) =>
                row.forEach((slug, x) =>
                    this.board.push({
                        player: secondPlayer.id,
                        x: 5 - x,
                        y: 5 - y,
                        card: {
                            tribe: secondPlayer.tribe,
                            type: "fighters",
                            slug,
                        },
                    }),
                ),
            );
        this._sendMessage(`**${secondPlayer.name}** a rejoint la partie.`);
        this._sendState();
        this.startTurn(Object.keys(this.players)[Math.round(Math.random())]);
    }

    leave(playerId) {
        const leavingPlayer = this.players[playerId];

        this._sendMessage(`**${leavingPlayer.name}** a quitté la partie.`);
    }

    resolveStack() {
        const action = this.stack.shift();

        // without action in the stack, change turn
        if (!action) {
            this.startTurn(this.endTurn());
            return;
        }

        // resolve action
        switch (action.type) {
            case ACTIONS.SELECT_CARD:
                this.turn.phase = "action";
                this.turn.action = action;
                this._sendState();
                break;

            case "power": {
                const {name, resolver, power} = resolveCard(action.source.card);

                if (!resolver) {
                    console.warn(`Power Action: no resolver for ${name}!`);
                    this._sendMessage(
                        `Le pouvoir de **${name}** n'est pas encore implémenté. Le combat est traité comme une égalité.`,
                    );
                    this.resolveStack();
                    return;
                }

                console.group(`${name} power resolver`);
                console.log({action, power});
                resolver(
                    this,
                    action,
                    () => {
                        this._sendState();
                        this.resolveStack();
                    },
                );
                console.groupEnd();
                break;
            }

            case "win":
                this.endGame(action.winner);
                break;

            default:
                console.log("Unhandled action type:", action.type, action);
                this.resolveStack();
                break;
        }
    }

    startTurn(playerId) {
        this.turn.count++;
        this.turn.activePlayer = playerId;
        this.stack = [];
        this.turn.phase = "main";
        this.turn.combat = null;
        this.turn.action = null;
        this._sendState();
        this._sendMessage(
            `Début de tour : **${this.players[playerId].name}**.`,
        );
        console.log(
            "Starting turn:",
            playerId,
            this.players[playerId].name,
            this.players[playerId].isFirstPlayer
                ? "(first player)"
                : "(second player)",
        );
    }

    endTurn() {
        this._sendMessage("Fin de tour.");
        // TODO: close turn, clean stuffs if needed

        // return nextPlayer id
        return Object.keys(this.players).find(
            id => id !== this.turn.activePlayer,
        );
    }

    endGame(winnerId) {
        this.turn.phase = "end";
        this.turn.winner = this.players[winnerId];
        this._sendState();
        this._sendMessage(
            `Partie terminée, **${this.players[winnerId].name}** a éliminé l'emblème de son adversaire.
[Rechargez](javascript:location.reload(true)) pour démarrer une nouvelle partie.`,
        );
    }

    move(card, destination) {
        const [move, isValid, isCombat] = this._checkMove(card, destination);

        if (!isValid) {
            // TODO: send proper error
            this._sendMessage("**Error** - déplacement invalide");
            return;
        }

        if (isCombat) {
            // perform combat
            this.turn.phase = "combat";
            this.turn.combat = {
                step: "choice",
                attacker: {
                    ...cloneDeep(this._getCardAtPosition(card)),
                    role: "attacker",
                    move,
                },
                defender: {
                    ...cloneDeep(this._getCardAtPosition(destination)),
                    role: "defender",
                },
            };
            this._sendMessage("**Combat** - lancement d'un combat.");
            this._sendState();
        } else {
            // perform move
            this._updateCardOnBoard(card, destination);
            this._sendState();
            this._sendMessageToActivePlayer(
                `**Déplacement** - _${resolveCard(card).name}_ de _${[
                    card.x,
                    card.y,
                ].join(",")}_ à _${[destination.x, destination.y].join(",")}_`,
            );
            this._sendMessageToInactivePlayer(
                `**Déplacement** - Zoon de _${[card.x, card.y].join(
                    ",",
                )}_ à _${[destination.x, destination.y].join(",")}_`,
            );

            this.resolveStack();
        }
    }

    combatChooseCorner(player, cornerIndex) {
        // encode corner
        ["attacker", "defender"].forEach(side => {
            if (this.turn.combat[side].player !== player) {
                // randomly rotate corners at 180º before computation
                const corner = ([0, 2].includes(cornerIndex) ? [0, 2] : [1, 3])[
                    Math.round(Math.random())
                ];
                this.turn.combat[side].cornerIndex = corner;
                this.turn.combat[side].value = resolveCard(
                    this.turn.combat[side].card,
                ).corners[corner];
            }
        });

        // resolve combat
        if (
            ["attacker", "defender"].every(
                side => this.turn.combat[side].value != null,
            )
        ) {
            const {attacker, defender} = this.turn.combat;
            const attackerValue = attacker.value;
            const defenderValue = defender.value;

            this.turn.combat.step = "resolve";

            if (attackerValue === defenderValue) {
                let attackerDestination =
                    " Les deux Zoons concervent leurs positions.";

                if (attacker.move.length > 1) {
                    const [x, y] = attacker.move[attacker.move.length - 2];
                    if (!this._getCardAtPosition({x, y})) {
                        this._updateCardOnBoard(attacker, {x, y});
                        attackerDestination = ` Le **${
                            resolveCard(attacker.card).name
                        }** attaquant recule en _${[x, y].join(",")}_.`;
                    }
                }
                this._sendMessage(
                    `**Combat** - le combat se solde par une égalité.${attackerDestination}`,
                );
                this.turn.combat.winner = "draw";
            } else if (attackerValue === "*") {
                this._sendMessage(
                    `**Combat** - le _${
                        resolveCard(attacker.card).name
                    }_ de **${
                        this.players[attacker.player].name
                    }** active son pouvoir (_${
                        resolveCard(attacker.card).power
                    }_).`,
                );
                this.turn.combat.winner = "power";
                this.turn.combat.powerOwner = "attacker";
                this.stack.push({
                    type: "power",
                    source: attacker,
                    target: defender,
                });
            } else if (defenderValue === "*") {
                this._sendMessage(
                    `**Combat** - le _${
                        resolveCard(defender.card).name
                    }_ de **${
                        this.players[defender.player].name
                    }** active son pouvoir (_${
                        resolveCard(defender.card).power
                    }_).`,
                );
                this.turn.combat.winner = "power";
                this.turn.combat.powerOwner = "defender";
                this.stack.push({
                    type: "power",
                    source: defender,
                    target: attacker,
                });
            } else if (attackerValue > defenderValue) {
                // attacker wins
                this._sendMessage(
                    `**Combat** - le _${
                        resolveCard(attacker.card).name
                    }_ de **${
                        this.players[attacker.player].name
                    }** élimine le _${resolveCard(defender.card).name}_ de **${
                        this.players[defender.player].name
                    }** et prend sa place en _${[defender.x, defender.y].join(
                        ",",
                    )}_.`,
                );
                this.turn.combat.winner = "attacker";
                this._eliminateCardAtPosition(defender);
                this._updateCardOnBoard(attacker, {
                    x: defender.x,
                    y: defender.y,
                });
            } else {
                // defender wins
                this._sendMessage(
                    `**Combat** - le _${
                        resolveCard(defender.card).name
                    }_ de **${
                        this.players[defender.player].name
                    }** élimine le _${resolveCard(attacker.card).name}_ de **${
                        this.players[attacker.player].name
                    }** et conserve sa position.`,
                );
                this.turn.combat.winner = "defender";
                this._eliminateCardAtPosition(attacker);
            }

            this._sendState();

            setTimeout(() => this.resolveStack(), 5000);
        }
    }

    _checkMove({x, y, ...cardInfos}, {x: dX, y: dY}) {
        const card = resolveCard(cardInfos);
        const moves = resolveMoves(
            {x, y},
            card.moves,
            !this.players[this.turn.activePlayer].isFirstPlayer,
        ).reduce((arr, move) => {
            move.reduce((keep, [mX, mY, isJump = false]) => {
                if (keep) {
                    const cardAtPosition = this.board.find(
                        crd => crd.x === mX && crd.y === mY,
                    );

                    if (cardAtPosition) {
                        if (cardAtPosition.player !== this.turn.activePlayer) {
                            arr.push([mX, mY, isJump, true, move]);
                        }

                        return false;
                    }

                    arr.push([mX, mY, isJump, false, move]);
                }

                return keep;
            }, true);

            return arr;
        }, []);

        const destination = moves.find(([mX, mY]) => dX === mX && dY === mY);
        const [, , , isCombat, move] = destination;

        return [move, !!destination, isCombat];
    }

    _getCardAtPosition({x, y}) {
        return this.board.find(cell => x === cell.x && y === cell.y);
    }

    _getCardIndex({x, y}) {
        return this.board.findIndex(cell => cell.x === x && cell.y === y);
    }

    _updateCardOnBoard({x, y}, data, replace = false) {
        const index = this._getCardIndex({x, y});

        this.board[index] = replace
            ? data
            : {
                  ...this.board[index],
                  ...data,
              };
    }

    _eliminateCardAtPosition({x, y}) {
        const index = this.board.findIndex(
            cell => cell.x === x && cell.y === y,
        );
        const [deadCard] = this.board.splice(index, 1);
        this._sendMessage(
            `Zoon éliminé: **${resolveCard(deadCard.card).name}**`,
        );
        if (resolveCard(deadCard.card).type === "EMBLEM") {
            this.stack.push({
                type: "win",
                winner: Object.keys(this.players).find(
                    id => id !== deadCard.player,
                ),
            });
        }
        this.graveyard.push(deadCard);
    }

    _sendMessage(message) {
        sendSystemMessage(this.server.to(this.room), message);
    }

    _sendMessageToActivePlayer(message) {
        const id = this.turn.activePlayer;

        sendSystemMessage(this.server.sockets[id], message);
    }

    _sendMessageToInactivePlayer(message) {
        const id = Object.keys(this.players).find(
            playerId => playerId !== this.turn.activePlayer,
        );

        sendSystemMessage(this.server.sockets[id], message);
    }

    _sendState() {
        Object.values(this.players).forEach(({id}) => {
            const state = {
                turn: {
                    ...cloneDeep(this.turn),
                    activePlayer: this.turn.activePlayer
                        ? this.players[this.turn.activePlayer]
                        : null,
                },
                player: this.players[id],
                opponent: Object.values(this.players).find(
                    player => player.id !== id,
                ),
                board: this.board.map(
                    ({player, x, y, card: {tribe, type, slug}}) => ({
                        player,
                        x,
                        y,
                        card: player === id ? {tribe, type, slug} : {tribe},
                    }),
                ),
            };

            if (state.turn.phase === "combat") {
                if (["choice", "wait"].includes(state.turn.combat.step)) {
                    ["attacker", "defender"].forEach(side => {
                        if (state.turn.combat[side].player !== id) {
                            state.turn.combat[side].card = {
                                tribe: state.turn.combat[side].card.tribe,
                            };
                        }
                    });
                }
            }

            if (state.turn.phase === "action") {
                // eslint-disable-next-line no-unused-vars
                const {next, ...action} = state.turn.action;

                state.turn.action = action;
                state.turn.action.options.player=this.players[state.turn.action.options.player];
            }

            if (this.server.sockets[id]) {
                this.server.sockets[id].emit("state", state);
            }
        });
    }
}
