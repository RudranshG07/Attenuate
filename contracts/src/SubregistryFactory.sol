// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ILabelStore} from "@ensv2/utils/interfaces/ILabelStore.sol";
import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensv2/registry/libraries/RegistryRolesLib.sol";

import {AttenuatedSubregistry} from "./AttenuatedSubregistry.sol";
import {GrantStore} from "./GrantStore.sol";
import {ISubregistryFactory} from "./interfaces/ISubregistryFactory.sol";

// A registry cannot instantiate its own type, so the initcode for one level of the tree
// lives here. The label store and grant store are fixed at construction, so a caller
// cannot hand a derived registry a grant store that would not enforce attenuation.
contract SubregistryFactory is ISubregistryFactory {
    ILabelStore public immutable LABEL_STORE;
    GrantStore public immutable STORE;

    event SubregistryDeployed(address indexed registry, address indexed agent);

    constructor(ILabelStore labelStore, GrantStore store) {
        LABEL_STORE = labelStore;
        STORE = store;
    }

    // Permissionless: a registry deployed here can do nothing until the grant store
    // authorizes it, and only the granting registry can do that.
    function deployFor(address agent) external returns (IRegistry) {
        AttenuatedSubregistry registry =
            new AttenuatedSubregistry(LABEL_STORE, agent, RegistryRolesLib.ROLE_REGISTRAR, STORE, this);
        emit SubregistryDeployed(address(registry), agent);
        return IRegistry(address(registry));
    }
}
