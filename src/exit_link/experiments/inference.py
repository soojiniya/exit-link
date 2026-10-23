"""Independent-position Wilson intervals and paired-block resampling only."""
import math
import random
import statistics


def wilson(successes, n):
    if n==0:
        return None
    if not 0<=successes<=n:
        raise ValueError('Invalid successes/n')
    z=1.959963984540054
    p=successes/n
    denominator=1+z*z/n
    center=(p+z*z/(2*n))/denominator
    half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/denominator
    return dict(n=n,successes=successes,estimate=p,lower=max(0,center-half),upper=min(1,center+half),
                confidence=.95,method='wilson_score',scope='one_message_position_per_independent_cell')


def paired_interval(pairs, seed=20261022, draws=5000):
    if not pairs:
        return None
    differences=[b-a for a,b in pairs]
    if len(differences)<2:
        return dict(n_pairs=1,estimate=differences[0],lower=None,upper=None,method='insufficient_pairs')
    rng=random.Random(seed)
    samples=sorted(statistics.mean(rng.choices(differences,k=len(differences))) for _ in range(draws))
    return dict(n_pairs=len(differences),estimate=statistics.mean(differences),lower=samples[math.ceil(.025*draws)-1],
                upper=samples[math.ceil(.975*draws)-1],confidence=.95,draws=draws,seed=seed,
                method='paired_cell_percentile_bootstrap',boundary_warning=len(set(differences))==1)
