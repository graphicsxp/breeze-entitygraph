import { EntityQuery, EntityManager, EntityState } from 'breeze-client';

export class EntityGraph {

    private _em: EntityManager;

    constructor(em: EntityManager) {
        this._em = em;
    }
    /**
     *  breezelabs getEntityGraph 
     */
     getEntityGraph(roots: any, expand: any) {
        if (roots instanceof EntityQuery) {
            let newRoots = this._em.executeQueryLocally(roots);
            return this._getEntityGraphCore(newRoots, expand || roots.expandClause);
        } else {
            return this._getEntityGraphCore(roots, expand);
        }
    }

    private  _getEntityGraphCore(roots: any, expand: any) {
        let entityGroupMap: any;
        let graph: any[] = [];
        let rootType: any;
        roots = Array.isArray(roots) ? roots : [roots];
        addToGraph(roots);     // removes dups & nulls
        roots = graph.slice(); // copy of de-duped roots
        if (roots.length) {
            getRootInfo();
            getExpand();
            buildGraph();
        }
        return graph;

        function addToGraph(entities: any) {
            entities.forEach(function (entity: any) {
                if (entity && graph.indexOf(entity) < 0) {
                    graph.push(entity);
                }
            });
        }

        function getRootInfo() {
            let compatTypes: any;

            roots.forEach(function (root: any, ix: any) {
                let aspect;
                if (!root || !(aspect = root.entityAspect)) {
                    throw getRootErr(ix, 'is not an entity');
                }
                if (aspect.entityState === EntityState.Detached) {
                    throw getRootErr(ix, 'is a detached entity');
                }

                let em = aspect.entityManager;
                if (entityGroupMap) {
                    if (entityGroupMap !== em._entityGroupMap) {
                        throw getRootErr(ix, "has a different 'EntityManager' than other roots");
                    }
                } else {
                    entityGroupMap = em._entityGroupMap;
                }
                getRootType(root, ix);

            });

            function getRootErr(ix: any, msg: any) {
                return new Error("'getEntityGraph' root[" + ix + "] " + msg);
            };

            function getRootType(root: any, ix: any) {
                let thisType = root.entityType;
                if (!rootType) {
                    rootType = thisType;
                    return;
                } else if (rootType === thisType) {
                    return;
                }
                // Types differs. Look for closest common base type
                // does thisType derive from current rootType?
                let baseType = rootType;
                do {
                    compatTypes = compatTypes || baseType.getSelfAndSubtypes();
                    if (compatTypes.indexOf(thisType) > -1) {
                        rootType = baseType;
                        return;
                    }
                    baseType = baseType.baseEntityType;
                    compatTypes = null;
                } while (baseType);

                // does current rootType derives from thisType?
                baseType = thisType;
                do {
                    compatTypes = baseType.getSelfAndSubtypes();
                    if (compatTypes.indexOf(rootType) > -1) {
                        rootType = baseType;
                        return;
                    }
                    baseType = baseType.baseEntityType;
                } while (baseType)

                throw getRootErr(ix, "is not EntityType-compatible with other roots");
            }
        }

        function getExpand() {
            try {
                if (!expand) {
                    expand = [];
                } else if (typeof expand === 'string') {
                    // tricky because Breeze expandClause not exposed publically
                    expand = new EntityQuery().expand(expand).expandClause;
                }
                if (expand.propertyPaths) { // expand clause
                    expand = expand.propertyPaths;
                } else if (Array.isArray(expand)) {
                    if (!expand.every(function (elem) { return typeof elem === 'string'; })) {
                        throw '';
                    }
                } else {
                    throw '';
                }
            } catch (_) {
                throw new Error(
                    "expand must be an expand string, array of string paths, or a query expand clause");
            }
        }

        function buildGraph() {
            if (expand && expand.length) {
                let fns = expand.map(makePathFn);
                fns.forEach(function (fn: any) { fn(roots); });
            }
        }

        // Make function to get entities along a single expand path
        // such as 'Orders.OrderDetails.Product'
        function makePathFn(path: any) {
            let fns: any[] | ((entity: any) => any)[] = [];
            let segments = path.split('.');
            let type = rootType;

            for (let i = 0, slen = segments.length; i < slen; i++) {
                let f = makePathSegmentFn(type, segments[i]);
                type = f.navType;
                fns.push(f);
            }

            return function pathFn(entities: any) {
                for (let j = 0, flen = fns.length; j < flen; j++) {
                    let elen = entities.length;
                    if (elen === 0) { return; } // nothing left to explore
                    // fn to get related entities for this path segment
                    let fn = fns[j];
                    // get entities related by this path segment
                    let related: any[] = [];
                    for (let k = 0; k < elen; k++) {
                        related = related.concat(fn(entities[k]));
                    }
                    addToGraph(related);
                    if (j >= flen - 1) { return; } // no more path segments

                    // reset entities to deduped related entities
                    entities = [];
                    for (let l = 0, rlen = related.length; l < rlen; l++) {
                        let r = related[l];
                        if (entities.indexOf(r) < 0) { entities.push(r); }
                    }
                }
            };
        }

        // Make function to get entities along a single expand path segment
        // such as the 'OrderDetails' in the 'Orders.OrderDetails.Product' path
        function makePathSegmentFn(baseType: any, segment: any) {
            let baseTypeName: any;
            let fn = undefined, navType;

            try {
                baseTypeName = baseType.name;
                let nav = baseType.getNavigationProperty(segment);
                let fkName = nav.foreignKeyNames[0];
                if (!nav) {
                    throw new Error(segment + " is not a navigation property of " + baseTypeName);
                }
                navType = nav.entityType;
                // add derived types
                let navTypes = navType.getSelfAndSubtypes();
                let grps: any[] | { _indexMap: { [x: string]: string | number; }; }[] = []; // non-empty groups for these types
                navTypes.forEach(function (t: any) {
                    let grp = entityGroupMap[t.name];
                    if (grp && grp._entities.length > 0) {
                        grps.push(grp);
                    }
                });
                let grpCount = grps.length;
                if (grpCount === 0) {
                    // no related entities in cache
                    fn = (): any => { return []; };
                } else if (fkName) {
                    fn = (entity: any) => {
                        let val = null;
                        try {
                            let keyValue = entity.getProperty(fkName);
                            for (let i = 0; i < grpCount; i += 1) {
                                val = grps[i]._entities[grps[i]._indexMap[keyValue]];
                                if (val) { break; }
                            }
                        } catch (e) { rethrow(e); }
                        return val;
                    };
                } else {
                    fkName = nav.inverse ?
                        nav.inverse.foreignKeyNames[0] :
                        nav.invForeignKeyNames[0];
                    if (!fkName) { throw new Error("No inverse keys"); }
                    fn = (entity: any) => {
                        let vals: any[] = [];
                        try {
                            let keyValue = entity.entityAspect.getKey().values[0];
                            grps.forEach(function (grp: any) {
                                vals = vals.concat(grp._entities.filter(function (en: any) {
                                    return en && en.getProperty(fkName) === keyValue;
                                }));
                            });
                        } catch (e) { rethrow(e); }
                        return vals;
                    };
                }
                fn.navType = navType;
                fn.path = segment;

            } catch (err) { rethrow(err); }
            return fn;

            function rethrow(e: any) {
                let typeName = baseTypeName || baseType;
                let error = new Error("'getEntityGraph' can't expand '" + segment + "' for " + typeName);
                error = e;
                throw error;
            }
        }
    }
}