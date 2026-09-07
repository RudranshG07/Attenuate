// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PermissionedRegistry} from "@ensv2/registry/PermissionedRegistry.sol";
import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";
import {ILabelStore} from "@ensv2/utils/interfaces/ILabelStore.sol";
import {RegistryRolesLib} from "@ensv2/registry/libraries/RegistryRolesLib.sol";

import {GrantStore} from "./GrantStore.sol";

contract AttenuatedSubregistry is PermissionedRegistry {
    GrantStore public immutable STORE;

    error UseRegisterWithGrant();

    event Granted(uint256 indexed tokenId, string label, address owner, GrantStore.Grant grant);
    event EscalationBlocked(
        address indexed attemptedBy,
        string label,
        GrantStore.Grant proposed,
        string reason,
        uint256 timestamp
    );

    constructor(ILabelStore labelStore, address rootAccount, uint256 roleBitmap, GrantStore store)
        PermissionedRegistry(labelStore, rootAccount, roleBitmap)
    {
        STORE = store;
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
        IRegistry childRegistry,
        GrantStore.Grant calldata grant
    ) external returns (uint256 tokenId) {
        _checkRoles(ROOT_RESOURCE, RegistryRolesLib.ROLE_REGISTRAR, msg.sender);
        return _mintAttenuated(label, owner, resolver, childRegistry, grant);
    }

    function registerOrLog(
        string calldata label,
        address owner,
        address resolver,
        IRegistry childRegistry,
        GrantStore.Grant calldata grant
    ) external returns (uint256 tokenId, bool ok, string memory reason) {
        _checkRoles(ROOT_RESOURCE, RegistryRolesLib.ROLE_REGISTRAR, msg.sender);

        try this.selfMint(label, owner, resolver, childRegistry, grant) returns (uint256 id) {
            return (id, true, "");
        } catch Error(string memory r) {
            emit EscalationBlocked(msg.sender, label, grant, r, block.timestamp);
            return (0, false, r);
        } catch {
            emit EscalationBlocked(msg.sender, label, grant, "REVERTED", block.timestamp);
            return (0, false, "REVERTED");
        }
    }

    function selfMint(
        string calldata label,
        address owner,
        address resolver,
        IRegistry childRegistry,
        GrantStore.Grant calldata grant
    ) external returns (uint256) {
        require(msg.sender == address(this), "ONLY_SELF");
        return _mintAttenuated(label, owner, resolver, childRegistry, grant);
    }

    function _mintAttenuated(
        string calldata label,
        address owner,
        address resolver,
        IRegistry childRegistry,
        GrantStore.Grant calldata grant
    ) internal returns (uint256 tokenId) {
        tokenId = _register(
            label, owner, childRegistry, resolver, _roleBitmapFor(grant), grant.expiry, false
        );

        STORE.grantTo(tokenId, owner, grant);

        emit Granted(tokenId, label, owner, grant);
    }

    function _roleBitmapFor(GrantStore.Grant calldata g) internal pure returns (uint256 bitmap) {
        bitmap = RegistryRolesLib.ROLE_SET_RESOLVER;
        if (g.capabilities & (1 << 7) != 0) {
            bitmap |= RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_SET_SUBREGISTRY;
        }
    }
}
