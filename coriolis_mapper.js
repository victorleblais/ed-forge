
const { Modules, Ships } = require('coriolis-data/dist');
const fs = require('fs');
const _ = require('lodash');

// Will be set in consumeModule; hardpoints and other modules don't share ids
const ID_TO_MODULE = {};
const ID_TO_MODULE_HP = {};

// --------
//  Helper
// --------

/**
 * Converts any number into a string with at least to characters by adding an
 * optional leading zero.
 * @param {Number} number Any number
 * @returns {String} String with optional leading zero
 */
function leadingZero(number) {
    return (number < 10 ? '0' : '') + String(number);
}

/**
 * This function will turn any value passed as second parameter into lowercase
 * if it is a string and return that; otherwise it just returns the value.
 * This is meant to be passed as replacer to JSON.stringify to guard
 * serialization.
 * An exception to this is rating.
 * @param {String} key JSON key
 * @param {*} value Accompanying value
 * @returns {*} value.toLowerCase() if value is a string; value otherwise
 */
function jsonReplacer(key, value) {
    if (typeof value === 'string' && key !== 'rating') {
        return value.toLowerCase();
    }
    return value;
}

// ------------------------------
//  Create src/data/modules.json
// ------------------------------

const MODULES = {};

const META_KEYS = [ 'eddbID', 'edID', 'rating' ];
const NOT_PROPS_KEYS = [ 'rating', 'class', 'eddbID', 'id', 'edID', 'symbol',
    'grp', 'mount', 'damagedist' ];
function modulePropsPicker(value, key) {
    return !NOT_PROPS_KEYS.includes(key);
}

function consumeModule(module) {
    let j = {
        proto: {
            Slot: '',
            On: true,
            Item: module.symbol,
            Priority: 1
        },
        props: _.pickBy(module, modulePropsPicker),
        meta: _.pick(module, META_KEYS),
    };

    let dist = module.damagedist;
    if (dist) {
        // Init damage dist
        j.props.thermdamage = 0;
        j.props.expldamage = 0;
        j.props.kindamage = 0;
        j.props.absdamage = 0;
        for (let type in dist) {
            switch (type) {
                case "T": j.props.thermdamage = dist.T;
                case "E": j.props.expldamage = dist.E;
                case "K": j.props.kindamage = dist.K;
                case "A": j.props.absdamage = dist.A;
            }
        }
    }

    MODULES[module.symbol.toLowerCase()] = j;
    (module.symbol.match(/Hpt_/i) ? ID_TO_MODULE_HP : ID_TO_MODULE)[module.id] = j;
}

// Get list of all bulkhead modules
const I_TO_GRADE = ['Grade1', 'Grade2', 'Grade3', 'Mirrored', 'Reactive'];
_.chain(_.values(Ships))
    .flatMap(ship => {
        // Inject symbol into bulkheads
        return _.chain(ship.bulkheads)
            .map((armour, i) => {
                armour.symbol =
                    // TODO: some ships map this value, for example the alliance ships
                    `${ship.properties.name}_Armour_${I_TO_GRADE[i]}`;
                return armour;
            })
            .value();
    })
    .forEach(consumeModule)
    .commit();

_.chain([ Modules.internal, Modules.standard, Modules.hardpoints ])
    .flatMap(_.values)  // to module groups
    .flatMap()          // to modules
    .forEach(consumeModule)
    .commit();

console.log('Writing /src/data/module.json');
fs.writeFile(
    './src/data/modules.json',
    JSON.stringify(MODULES, jsonReplacer, 4),
    function () {}
);

// ----------------------------
//  Create src/data/ships.json
// ----------------------------

const SHIPS = {};

const HP_SIZE_TO_DESCRIPTOR = [ 'Tiny', 'Small', 'Medium', 'Large', 'Huge' ];
const CORE_SLOTS = [ 'PowerPlant', 'MainEngine', 'FrameShiftDrive',
    'LifeSupport', 'PowerDistributor', 'Radar', 'FuelTank' ];
const CORE_ITEM_MAP = [ 'Int_PowerPlant', 'Int_Engine', 'Int_HyperDrive',
    'Int_LifeSupport', 'Int_PowerDistributor', 'Int_Sensors', 'Int_FuelTank' ];
const RATING_MAP = {
    'A': 5,
    'B': 4,
    'C': 3,
    'D': 2,
    'E': 1,
};

function consumeShip(ship) {
    let j = {
        proto: {
            Ship: ship.properties.name,
            ShipId: 0,
            ShipName: '',
            ShipIdent: '',
            Modules: [
                // Give lightweight armour to ship
                _.assign(
                    _.clone(MODULES[`${ship.properties.name}_Armour_Grade1`.toLowerCase()].proto),
                    { Slot: 'Armour' }
                ),
            ],
        },
        props: _.pickBy(ship.properties, (v, k) => k !== 'name'),
        meta: _.pick(ship, META_KEYS),
    };

    // Add core slots with default modules
    let cores = _.chain(CORE_SLOTS)
        .map((slot, i) => {
            let defaultType = ship.defaults.standard[i]; // is of form /\d\w/
            let size = defaultType[0];
            let rating = RATING_MAP[defaultType[1]];
            let moduleKey = `${CORE_ITEM_MAP[i]}_Size${size}_Class${rating}`;
            let module = _.clone(MODULES[moduleKey.toLowerCase()].proto);
            module.Slot = slot;
            return module;
        })
        .value();
    j.proto.Modules.push(...cores);

    // Add internal slots with default modules
    let slotIndexOffset = ship.properties.name == 'type_9_heavy' ? 1 : 0;
    let militaryCounter = 1;
    let internalToSlot = (internal, i) => {
        let key;
        if (typeof internal === 'object' && internal.name === 'Military') {
            key = `Military${leadingZero(militaryCounter)}`;
            militaryCounter++;
        } else {
            let size = typeof internal === 'object'
                ? internal = internal.class
                : internal; // typeof internal === 'number'
            let slotNumber = i + 1;             // slot numbers are 1 indexed
            slotNumber -= slotIndexOffset;      // ... unless you're the type 9
            slotNumber -= (militaryCounter - 1);  // And we don't count militaries
            key = `Slot${leadingZero(slotNumber)}_Size${size}`;
        }
        return key;
    };
    let internals = _.chain(ship.slots.internal)
        .map(internalToSlot)
        .map((slot, i) => {
            let defaultId = ship.defaults.internal[i];
            let module = defaultId ? _.clone(ID_TO_MODULE[defaultId].proto)
                : { Slot: '', On: true, Item: '', Priority: 1 };
            module.Slot = slot;
            return module;
        })
        .value();
    j.proto.Modules.push(...internals);

    // Add hardpoint and utility slots slots with default modules
    let hardpointCounters = [ 1, 1, 1, 1, 1 ];
    let hardpointToSlot = (hardpoint) => {
        let slot = `${HP_SIZE_TO_DESCRIPTOR[hardpoint]}Hardpoint${hardpointCounters[hardpoint]}`;
        hardpointCounters[hardpoint]++;
        return slot;
    };
    let hardpoints = _.chain(ship.slots.hardpoints)
        .map(hardpointToSlot)
        .map((slot, i) => {
            let hardpointId = ship.defaults.hardpoints[i];
            // default IDs for hardpoints happen to be integers
            let module = hardpointId ? _.clone(ID_TO_MODULE_HP[String(hardpointId)].proto)
                : { Slot: '', On: true, Item: '', Priority: 1 };
            module.Slot = slot;
            return module;
        })
        .value();
    j.proto.Modules.push(...hardpoints);

    SHIPS[ship.properties.name.toLowerCase()] = j;
}

_.chain(_.values(Ships))
    .forEach(consumeShip)
    .commit();

console.log('Writing /src/data/ships.json');
fs.writeFile(
    './src/data/ships.json',
    JSON.stringify(SHIPS, jsonReplacer, 4),
    function () {}
);
