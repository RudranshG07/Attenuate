// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PermissionedRegistry} from "@ensv2/registry/PermissionedRegistry.sol";
import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";
import {ILabelStore} from "@ensv2/utils/interfaces/ILabelStore.sol";
import {RegistryRolesLib} from "@ensv2/registry/libraries/RegistryRolesLib.sol";

import {GrantStore} from "./GrantStore.sol";
import {ISubregistryFactory} from "./interfaces/ISubregistryFactory.sol";

contract AttenuatedSubregistry is PermissionedRegistry {
    GrantStore public immutable STORE;
    ISubregistryFactory public immutable FACTORY;

    error UseRegisterWithGrant();

    event Granted(uint256 indexed tokenId, string label, address owner, GrantStore.Grant grant);
    event ChildRegistryDerived(uint256 indexed tokenId, address registry, address agent);
    event EscalationBlocked(
        address indexed attemptedBy,
        string label,
        GrantStore.Grant proposed,
        string reason,
        uint256 timestamp
    );

    constructor(
        ILabelStore labelStore,
        address rootAccount,
        uint256 roleBitmap,
        GrantStore store,
        ISubregistryFactory factory
    ) PermissionedRegistry(labelStore, rootAccount, roleBitmap) {
        STORE = store;
        FACTORY = factory;
    }

    function register(string memory, address, IRegistry, address, uint256, uint64)
        public
        pure
        override
        returns (uint256)
    {
        revert UseRegisterWithGrant();
    }

    function registerWithGrant(
        string calldata label,
        address owner,
        address resolver,
        GrantStore.Grant calldata grant
    ) external returns (uint256 tokenId) {
        _checkRoles(ROOT_RESOURCE, RegistryRolesLib.ROLE_REGISTRAR, msg.sender);
        return _mintAttenuated(label, owner, resolver, grant);
    }

    function registerOrLog(
        string calldata label,
        address owner,
        address resolver,
        GrantStore.Grant calldata grant
    ) external returns (uint256 tokenId, bool ok, string memory reason) {
        _checkRoles(ROOT_RESOURCE, RegistryRolesLib.ROLE_REGISTRAR, msg.sender);

        try this.selfMint(label, owner, resolver, grant) returns (uint256 id) {
            return (id, true, "");
        } catch Error(string memory r) {
            emit EscalationBlocked(msg.sender, label, grant, r, block.timestamp);
            return (0, false, r);
        } catch {
            emit EscalationBlocked(msg.sender, label, grant, "REVERTED", block.timestamp);
            return (0, false, "REVERTED");
        }
    }

    // Split from ROLE_REGISTRAR on purpose: whoever can kill a name cannot mint one, and
    // whoever can mint cannot kill. Bumping the epoch here kills every descendant too.
    function revokeGrant(uint256 tokenId) external {
        _checkRoles(ROOT_RESOURCE, RegistryRolesLib.ROLE_UNREGISTER, msg.sender);
        STORE.revoke(tokenId);
    }

    function selfMint(
        string calldata label,
        address owner,
        address resolver,
        GrantStore.Grant calldata grant
    ) external returns (uint256) {
        require(msg.sender == address(this), "ONLY_SELF");
        return _mintAttenuated(label, owner, resolver, grant);
    }

    function _mintAttenuated(
        string calldata label,
        address owner,
        address resolver,
        GrantStore.Grant calldata grant
    ) internal returns (uint256 tokenId) {
        // Refuse before deriving a registry, so a refused grant never pays for a deployment.
        STORE.assertCanGrant(grant);

        // A delegating name delegates through a registry it does not choose, whose only
        // registrar is its own agent. Withholding the bit leaves the name a leaf whatever
        // maxDepth says, because there is no registry under it to mint into.
        IRegistry childRegistry;
        if (grant.capabilities & STORE.CAP_DELEGATE() != 0) {
            childRegistry = FACTORY.deployFor(owner);
        }

        // No roles on the name's own resource. An agent that can repoint its resolver or
        // its subregistry can rewrite the permissions its name publishes, and withholding
        // ROLE_CAN_TRANSFER_ADMIN leaves the name non-transferable.
        tokenId = _register(label, owner, childRegistry, resolver, 0, grant.expiry, false);

        STORE.grantTo(tokenId, owner, grant);

        if (address(childRegistry) != address(0)) {
            STORE.authorizeChildRegistry(address(childRegistry), tokenId);
            emit ChildRegistryDerived(tokenId, address(childRegistry), owner);
        }

        emit Granted(tokenId, label, owner, grant);
    }
}
